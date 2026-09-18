#!/usr/bin/env node
// Milestone 0 spike — NOT product code. Throwaway tooling for observing what Claude Code
// actually sends. Dump-only passthrough proxy + hook receiver + `claude` launcher.
//
//   node scripts/spike/capture.mjs [--out DIR] [--no-hooks] [--] <claude args...>
//
// Guarantees:
//   * request/response bytes are forwarded untouched (except accept-encoding is dropped so the
//     response is readable identity-encoded; the real proxy will not do this)
//   * credential headers (authorization, x-api-key, cookie, ...) are never written to disk
//   * raw dumps contain prompts and identifiers; they live under _dumps/ (gitignored) and are
//     turned into redacted fixtures by redact-fixtures.mjs
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
let out = join("_dumps", new Date().toISOString().replace(/[:.]/g, "-"));
let hooks = true;
const claudeArgs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--out") out = argv[++i];
  else if (a === "--no-hooks") hooks = false;
  else if (a === "--") { claudeArgs.push(...argv.slice(i + 1)); break; }
  else claudeArgs.push(a);
}
mkdirSync(out, { recursive: true, mode: 0o700 });

const upstream = new URL(process.env.REFLEX_SPIKE_UPSTREAM ?? "https://api.anthropic.com");
const SECRET_HEADERS = new Set(["authorization", "x-api-key", "cookie", "proxy-authorization", "set-cookie"]);
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding"]);
let seq = 0;

const scrubHeaders = (h) => {
  const o = {};
  for (const [k, v] of Object.entries(h)) o[k] = SECRET_HEADERS.has(k.toLowerCase()) ? "[omitted]" : v;
  return o;
};
const parse = (s) => { try { return JSON.parse(s); } catch { return s; } };
const slug = (p) => p.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "root";

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://x");

    if (url.pathname === "/__spike/hook") {
      appendFileSync(join(out, "hooks.jsonl"), JSON.stringify({ t: Date.now(), body: parse(raw.toString("utf8")) }) + "\n");
      res.writeHead(204).end();
      return;
    }

    const n = String(++seq).padStart(3, "0");
    const base = `${n}-${req.method}-${slug(url.pathname)}`;
    const started = Date.now();
    writeFileSync(join(out, `${base}.req.json`), JSON.stringify({
      t: started, method: req.method, url: req.url, headers: scrubHeaders(req.headers),
      body_bytes: raw.length, body: raw.length ? parse(raw.toString("utf8")) : null,
    }, null, 1));
    process.stderr.write(`[spike] #${n} ${req.method} ${req.url} (${raw.length}B)\n`);

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    headers.host = upstream.host;
    if (raw.length) headers["content-length"] = String(raw.length);
    const lib = upstream.protocol === "https:" ? https : http;
    const up = lib.request({
      protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined,
      method: req.method, path: req.url, headers,
    }, (ur) => {
      const rc = [];
      const outHeaders = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) outHeaders[k] = v;
      res.writeHead(ur.statusCode ?? 502, outHeaders);
      ur.on("data", (c) => { rc.push(c); res.write(c); });
      ur.on("end", () => {
        res.end();
        const text = Buffer.concat(rc).toString("utf8");
        writeFileSync(join(out, `${base}.res.json`), JSON.stringify({
          ms: Date.now() - started, status: ur.statusCode, headers: scrubHeaders(ur.headers),
          body_bytes: text.length, body_head: text.slice(0, 200_000),
        }, null, 1));
      });
    });
    up.on("error", (e) => {
      process.stderr.write(`[spike] upstream error: ${e.message}\n`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { message: `spike proxy: ${e.message}` } }));
    });
    if (raw.length) up.write(raw);
    up.end();
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    // We may be running inside a Claude Code session: drop its markers so the child starts clean.
    if (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE") continue;
    env[k] = v;
  }
  env.ANTHROPIC_BASE_URL = base;

  const args = [...claudeArgs];
  if (hooks) {
    const hookEntry = (matcher) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "http", url: `${base}/__spike/hook`, timeout: 5 }] });
    const settings = {
      env: { ANTHROPIC_BASE_URL: base },
      hooks: {
        SessionStart: [hookEntry()], UserPromptSubmit: [hookEntry()],
        PreToolUse: [hookEntry("*")], PostToolUse: [hookEntry("*")], PostToolUseFailure: [hookEntry("*")],
        SubagentStart: [hookEntry()], SubagentStop: [hookEntry()], Stop: [hookEntry()],
      },
    };
    const f = join(out, "spike-settings.json");
    writeFileSync(f, JSON.stringify(settings, null, 1));
    args.unshift("--settings", f);
  }
  writeFileSync(join(out, "meta.json"), JSON.stringify({ started: new Date().toISOString(), claudeArgs: args, upstream: upstream.href }, null, 1));
  process.stderr.write(`[spike] proxy ${base} -> ${upstream.href}; dumping to ${out}\n`);

  const child = spawn(process.env.REFLEX_CLAUDE_BIN ?? "claude", args, { stdio: "inherit", env });
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => child.kill(s));
  child.on("exit", (code, signal) => {
    server.close();
    process.stderr.write(`[spike] claude exited code=${code} signal=${signal}; ${seq} requests captured in ${out}\n`);
    process.exit(signal ? 1 : (code ?? 0));
  });
  child.on("error", (e) => { process.stderr.write(`[spike] cannot start claude: ${e.message}\n`); process.exit(1); });
});
