#!/usr/bin/env node
// Spike (not product code): why does the interactive main chat's first request, retargeted to Haiku by
// src/wire/rewrite.ts, get a 400 when the same rewrite passes under `claude -p`?
//
// Starts an INTERACTIVE claude (TUI, cc_entrypoint=cli) inside a pseudo-terminal (pty-run.py), types one short prompt,
// and intercepts the first main-chat request that carries tools. That request is probed against the target with
// variants (product rewrite as is; + 1-hour cache TTL removed; + max_tokens capped to the target's output limit;
// both). Probes stop at `message_start` and are aborted. The real turn is NOT sent: the proxy answers it with 503 and
// ends the session, so the only model spend is the probes. Other requests (startup probe, quota check) pass through.
//
//   node --import tsx scripts/spike/first-turn-probe.mjs --model opus --to haiku --out DIR --cap-usd 0.25
//
// Recorded: statuses, API error messages, shape facts (max_tokens, thinking, effort, cache TTLs, beta names, tool
// count, top-level keys), rewritten fields, usage, estimated cost. No prompt text, no headers.
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRequest } from "../../src/wire/claude-code.ts";
import { retarget } from "../../src/wire/rewrite.ts";
import { tierOfModel } from "../../src/tiers.ts";

const argv = process.argv.slice(2);
const flag = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const model = flag("--model", "opus");
const to = flag("--to", "haiku");
const out = flag("--out", join("_dumps", "first-turn-" + Date.now()));
const capUsd = Number(flag("--cap-usd", "0.25"));
const prompt = flag("--prompt", "Reply with the single word OK.");
mkdirSync(out, { recursive: true, mode: 0o700 });

const MODELS = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-5", opus: "claude-opus-5" };
/** Documented maximum output tokens of the target (Haiku 4.5: 64k). */
const MAX_OUTPUT = { haiku: 64000, sonnet: 128000, opus: 128000 };
const upstream = new URL("https://api.anthropic.com");
const SKIP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding", "proxy-authorization", "te", "trailer"]);
const PRICE = { sonnet: [2, 10], haiku: [1, 5], opus: [5, 25] };
const costUsd = (m, u) => {
  if (!u) return 0;
  const [pin, pout] = PRICE[Object.keys(PRICE).find((k) => String(m).includes(k)) ?? "opus"];
  const c = u.cache_creation ?? {};
  const w1h = c.ephemeral_1h_input_tokens ?? 0;
  const w5m = c.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h);
  return ((u.input_tokens ?? 0) * pin + w5m * pin * 1.25 + w1h * pin * 2 + (u.cache_read_input_tokens ?? 0) * pin * 0.1 + (u.output_tokens ?? 0) * pout) / 1e6;
};
const log = (s) => process.stderr.write(`[probe] ${s}\n`);

let spent = 0;
const probes = [];
let facts = null;
let intercepted = false;
let child = null;

const ttls = (v, acc = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => ttls(x, acc));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "cache_control" && x && typeof x === "object") acc.add(x.ttl ?? "(default 5m)"); ttls(x, acc); }
  return acc;
};
const stripTtl = (v) => {
  if (Array.isArray(v)) return v.map(stripTtl);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "cache_control" && x && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([kk]) => kk !== "ttl")) : stripTtl(x)]));
  return v;
};

function send(path, headers, body) {
  return new Promise((resolve) => {
    const req = https.request({ hostname: upstream.hostname, method: "POST", path, headers: { ...headers, host: upstream.host, "content-length": String(body.length), "accept-encoding": "identity" } }, (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c.toString("utf8");
        if (res.statusCode < 400) {
          const m = /data: (\{"type":"message_start".*)\n/.exec(buf);
          if (m) { let usage = null; try { usage = JSON.parse(m[1]).message.usage; } catch { /* partial */ } res.destroy(); req.destroy(); resolve({ status: res.statusCode, usage }); }
        }
      });
      res.on("end", () => { let error = buf.slice(0, 300); try { error = JSON.parse(buf).error.message; } catch { /* raw */ } resolve({ status: res.statusCode, error }); });
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.end(body);
  });
}

async function probe(label, path, headers, bodyObj, fields) {
  if (spent >= capUsd) { probes.push({ label, skipped: "cap reached" }); return null; }
  const body = Buffer.from(JSON.stringify(bodyObj));
  const r = await send(path, headers, body);
  const usd = costUsd(bodyObj.model, r.usage);
  spent += usd;
  probes.push({ label, status: r.status, accepted: r.status === 200, error: r.status === 200 ? null : r.error, fields, max_tokens: bodyObj.max_tokens, thinking: bodyObj.thinking ?? null, cache_ttls: [...ttls(bodyObj)], usage: r.usage ?? null, est_usd: Number(usd.toFixed(5)) });
  log(`${r.status === 200 ? "ACCEPT" : "reject"} ${r.status} ${label}${r.status === 200 ? "" : " :: " + String(r.error).slice(0, 200)}  (spent ~$${spent.toFixed(3)})`);
  return r.status === 200;
}

async function investigate(req, raw, headers) {
  const parsed = JSON.parse(raw.toString("utf8"));
  const from = tierOfModel(parsed.model);
  facts = {
    model: parsed.model, keys: Object.keys(parsed), max_tokens: parsed.max_tokens, thinking: parsed.thinking ?? null, output_config: parsed.output_config ?? null,
    context_management: parsed.context_management ?? null, cache_ttls: [...ttls(parsed)], tools: parsed.tools?.length ?? 0,
    roles: parsed.messages.map((m) => m.role[0]).join(""), betas: String(headers["anthropic-beta"] ?? "").split(",").map((x) => x.trim()).filter(Boolean), user_agent: headers["user-agent"],
  };
  log(`intercepted ${parsed.model}: max_tokens=${facts.max_tokens} ttls=${facts.cache_ttls} effort=${parsed.output_config?.effort} betas=${facts.betas.length}`);
  const base = retarget(raw, { from, to, model: MODELS[to] });
  if (!base.ok) { log(`rewrite failed: ${base.reason}`); return; }
  const b0 = JSON.parse(base.body.toString("utf8"));
  const noTtlHeaders = { ...headers, "anthropic-beta": facts.betas.filter((x) => !x.startsWith("extended-cache-ttl-")).join(",") };
  const cap = (b) => { const c = structuredClone(b); if (c.max_tokens > MAX_OUTPUT[to]) { c.max_tokens = MAX_OUTPUT[to]; if (c.thinking?.budget_tokens >= c.max_tokens) c.thinking.budget_tokens = c.max_tokens - 1; } return c; };

  const ok0 = await probe("V0 product rewrite", req.url, headers, b0, base.fields);
  if (ok0) return;
  const okTtl = await probe("V1 + 1h TTL removed (beta and cache_control.ttl)", req.url, noTtlHeaders, stripTtl(b0), [...base.fields, "cache_ttl"]);
  const okMax = await probe(`V2 + max_tokens capped to ${MAX_OUTPUT[to]}`, req.url, headers, cap(b0), [...base.fields, "max_tokens"]);
  if (!okTtl && !okMax) await probe("V3 + both", req.url, noTtlHeaders, cap(stripTtl(b0)), [...base.fields, "cache_ttl", "max_tokens"]);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!SKIP.has(k)) headers[k] = v;
    const view = req.method === "POST" && req.url.startsWith("/v1/messages") ? (() => { const r = parseRequest(req.headers, raw); return r.ok ? r.view : null; })() : null;
    if (!intercepted && view && view.kind === "main" && view.turn === "new" && view.toolCount > 0 && String(view.requestedModel).includes(model)) {
      intercepted = true;
      try { await investigate(req, raw, headers); } catch (e) { log(`error ${e.message}`); }
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "probe finished" } }));
      finish();
      return;
    }
    if (intercepted) { res.writeHead(503).end(); return; }
    const up = https.request({ hostname: upstream.hostname, method: req.method, path: req.url, headers: { ...headers, host: upstream.host, ...(raw.length ? { "content-length": String(raw.length) } : {}), "accept-encoding": "identity" } }, (ur) => {
      const oh = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!SKIP.has(k)) oh[k] = v;
      res.writeHead(ur.statusCode, oh);
      let text = "";
      ur.on("data", (c) => { text += c.toString("utf8"); res.write(c); });
      ur.on("end", () => {
        res.end();
        let usage = null;
        for (const m of text.matchAll(/data: (\{"type":"message_(?:start|delta)".*)\n/g)) { try { const o = JSON.parse(m[1]); usage = { ...usage, ...(o.message?.usage ?? o.usage) }; } catch { /* partial */ } }
        let bm = null; try { bm = JSON.parse(raw.toString("utf8")).model; } catch { /* not json */ }
        spent += costUsd(bm, usage);
        log(`passthrough ${req.method} ${req.url.split("?")[0]} ${ur.statusCode} ${bm ?? ""}`);
      });
    });
    up.on("error", (e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e.message)); });
    up.end(raw);
  });
});

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  writeFileSync(join(out, "results.json"), JSON.stringify({ model, to, cap_usd: capUsd, est_total_usd: Number(spent.toFixed(4)), facts, probes }, null, 1));
  log(`done; estimated spend $${spent.toFixed(3)}; results in ${out}/results.json`);
  setTimeout(() => { try { process.kill(-child.pid, "SIGTERM"); } catch { child?.kill("SIGTERM"); } server.close(); process.exit(0); }, 1000);
}

server.listen(0, "127.0.0.1", () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) { if (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE") continue; env[k] = v; }
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  // pty-run.py gives claude a real pseudo-terminal, so it starts the interactive TUI (cc_entrypoint=cli), and types
  // the prompt (then Enter) once the TUI is up.
  child = spawn("python3", [join(import.meta.dirname, "pty-run.py"), "8", prompt, "9", "\\r", "--", "claude", "--model", model], { stdio: ["ignore", "ignore", "inherit"], env, detached: true });
  setTimeout(() => { if (!intercepted) { log("no main-chat request within 90 s"); finish(); } }, 90000);
});
