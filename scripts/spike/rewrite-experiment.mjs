#!/usr/bin/env node
// Spike (not product code): which fields does the Anthropic API reject when a real Claude Code request made for
// Sonnet is retargeted to Haiku 4.5?
//
//   node scripts/spike/rewrite-experiment.mjs --out DIR -- <claude args>
//
// The proxy intercepts the FIRST /v1/messages request that carries tools and re-sends it several times with
// different rewrites, using the headers of that same live request (held in memory only, never written; credential
// headers are not recorded). For every variant it records only the HTTP status and, for rejections, the API's
// error message. Accepted variants are aborted as soon as the response headers arrive. Finally the fully rewritten
// (or, if that failed, the original) request is forwarded so the real claude run completes normally.
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
let out = join("_dumps", "rewrite-" + Date.now());
const claudeArgs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") out = argv[++i];
  else if (argv[i] === "--") { claudeArgs.push(...argv.slice(i + 1)); break; }
  else claudeArgs.push(argv[i]);
}
mkdirSync(out, { recursive: true, mode: 0o700 });

const HAIKU = "claude-haiku-4-5-20251001";
const upstream = new URL("https://api.anthropic.com");
const SKIP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding", "proxy-authorization", "te", "trailer"]);
const SECRET = new Set(["authorization", "x-api-key", "cookie"]);

// ---- rewrite steps (each is idempotent and works on a deep copy) --------------------------------------------
const clone = (o) => JSON.parse(JSON.stringify(o));
const STEPS = {
  S1_model: (b) => { b.model = HAIKU; },
  S2_drop_output_config_effort: (b) => { if (b.output_config) { delete b.output_config.effort; if (Object.keys(b.output_config).length === 0) delete b.output_config; } },
  S3_thinking_adaptive_to_enabled: (b) => { if (b.thinking?.type === "adaptive") b.thinking = { type: "enabled", budget_tokens: 31999, ...(b.thinking.display ? { display: b.thinking.display } : {}) }; },
  S4_max_tokens_32000: (b) => { if (typeof b.max_tokens === "number") b.max_tokens = Math.min(b.max_tokens, 32000); },
  S5_strip_betas: (_b, h) => { if (h["anthropic-beta"]) h["anthropic-beta"] = h["anthropic-beta"].split(",").filter((x) => !/^(effort-|mid-conversation-system-)/.test(x.trim())).join(","); },
  S6_fold_system_messages: (b) => {
    const msgs = b.messages;
    const blocks = (m) => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
    const outMsgs = [];
    let pending = [];
    for (const m of msgs) {
      if (m.role === "system") {
        const target = [...outMsgs].reverse().find((x) => x.role === "user");
        const add = blocks(m);
        if (target) { target.content = [...blocks(target), ...add]; } else pending.push(...add);
      } else {
        const copy = { ...m };
        if (pending.length && copy.role === "user") { copy.content = [...blocks(copy), ...pending]; pending = []; }
        outMsgs.push(copy);
      }
    }
    b.messages = outMsgs;
  },
};
const ORDER = Object.keys(STEPS);
const variant = (steps) => ({ label: steps.length === ORDER.length ? "C6:all" : steps.join("+"), steps });
const VARIANTS = [
  ...ORDER.map((_, i) => ({ ...variant(ORDER.slice(0, i + 1)), label: `C${i + 1}:cumulative through ${ORDER[i]}` })),
  ...ORDER.slice(1).map((s) => ({ ...variant(ORDER.filter((x) => x !== s)), label: `LOO:all except ${s}` })),
];

const apply = (rawBody, headers, steps) => {
  const b = clone(rawBody);
  const h = { ...headers };
  for (const s of steps) STEPS[s](b, h);
  return { body: JSON.stringify(b), headers: h };
};

const sendOnce = (path, headers, body, { abortOnHeaders }) => new Promise((resolve) => {
  const h = { ...headers, host: upstream.host, "content-length": String(Buffer.byteLength(body)), "accept-encoding": "identity" };
  const req = https.request({ hostname: upstream.hostname, method: "POST", path, headers: h }, (res) => {
    if (res.statusCode < 400 && abortOnHeaders) { res.destroy(); req.destroy(); resolve({ status: res.statusCode }); return; }
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
  });
  req.on("error", (e) => resolve({ status: 0, text: String(e.message) }));
  req.end(body);
});

let done = false;
const results = [];

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!SKIP.has(k)) headers[k] = v;
    let parsed = null;
    try { parsed = raw.length ? JSON.parse(raw.toString("utf8")) : null; } catch { /* not json */ }

    let forwardBody = raw;
    let forwardHeaders = headers;
    if (!done && req.method === "POST" && req.url.startsWith("/v1/messages") && parsed && Array.isArray(parsed.tools) && parsed.tools.length > 0 && String(parsed.model).includes("sonnet")) {
      done = true;
      process.stderr.write(`[exp] intercepted ${parsed.model}; trying ${VARIANTS.length} variants\n`);
      for (const v of VARIANTS) {
        const { body, headers: h } = apply(parsed, headers, v.steps);
        const r = await sendOnce(req.url, h, body, { abortOnHeaders: true });
        let message = null;
        if (r.status >= 400 && r.text) { try { message = JSON.parse(r.text).error?.message ?? r.text.slice(0, 300); } catch { message = r.text.slice(0, 300); } }
        results.push({ label: v.label, steps: v.steps, accepted: r.status === 200, status: r.status, error: message });
        process.stderr.write(`[exp] ${r.status === 200 ? "ACCEPT" : "reject"} ${r.status} ${v.label}${message ? " :: " + message.slice(0, 140) : ""}\n`);
      }
      const full = results.find((r) => r.label === "C6:all");
      if (full?.accepted) ({ body: forwardBody, headers: forwardHeaders } = (() => { const a = apply(parsed, headers, ORDER); return { body: Buffer.from(a.body), headers: a.headers }; })());
    }

    const lib = https;
    const up = lib.request({ hostname: upstream.hostname, method: req.method, path: req.url, headers: { ...forwardHeaders, host: upstream.host, ...(forwardBody.length ? { "content-length": String(forwardBody.length) } : {}), "accept-encoding": "identity" } }, (ur) => {
      const oh = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!SKIP.has(k)) oh[k] = v;
      res.writeHead(ur.statusCode, oh);
      ur.pipe(res);
    });
    up.on("error", (e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e.message)); });
    up.end(forwardBody);
  });
});

server.listen(0, "127.0.0.1", () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) { if (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE") continue; env[k] = v; }
  env.ANTHROPIC_BASE_URL = base;
  const child = spawn("claude", claudeArgs, { stdio: ["ignore", "inherit", "inherit"], env });
  child.on("exit", (code) => {
    server.close();
    writeFileSync(join(out, "results.json"), JSON.stringify({ target: HAIKU, steps: ORDER, results }, null, 1));
    process.stderr.write(`[exp] claude exited ${code}; results in ${out}/results.json\n`);
    process.exit(code ?? 1);
  });
});
