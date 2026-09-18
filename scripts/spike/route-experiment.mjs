#!/usr/bin/env node
// Spike (not product code): does the API accept Claude Code requests retargeted from Sonnet 5 to Haiku 4.5 by
// src/wire/rewrite.ts in the shapes route mode will actually produce? One real `claude -p` session is routed through
// this proxy the way route mode would route it, and at each interesting point extra PROBES are sent:
//
//   subagent-first        first subagent request, rewritten to Haiku (then the subagent stays pinned to Haiku)
//   subagent-pinned       later subagent requests, rewritten (Haiku history, client still asks for Sonnet)
//   main-cont1:*          first main-chat continuation: Sonnet thinking + tool_use in history, system messages
//                         mid-list and trailing. Variants: keep history thinking / drop it / no `display`
//                         (interactive shape) / + redact-thinking beta (interactive header)
//   main-pinned           later main continuations rewritten again (history now holds Haiku turns)
//   unpin-to-sonnet       the same later request sent UNCHANGED to Sonnet: Haiku-made thinking in a Sonnet request
//                         (what the retry-with-original safety net and a pin release would send)
//
//   node --import tsx scripts/spike/route-experiment.mjs --out DIR --cap-usd 0.45 -- <claude args>
//
// Headers of the live request (auth included) are held in memory only and never written. Probes stop reading at
// `message_start` (enough for status and input usage) and are aborted. Recorded per probe: status, API error
// message, shape facts, rewritten fields, usage and an estimated cost. No prompt text is recorded.
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRequest } from "../../src/wire/claude-code.ts";
import { retarget } from "../../src/wire/rewrite.ts";

const argv = process.argv.slice(2);
let out = join("_dumps", "route-exp-" + Date.now());
let capUsd = 0.45;
let cwd = process.cwd();
const claudeArgs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") out = argv[++i];
  else if (argv[i] === "--cap-usd") capUsd = Number(argv[++i]);
  else if (argv[i] === "--cwd") cwd = argv[++i];
  else if (argv[i] === "--") { claudeArgs.push(...argv.slice(i + 1)); break; }
}
mkdirSync(out, { recursive: true, mode: 0o700 });

const HAIKU = "claude-haiku-4-5-20251001";
const upstream = new URL("https://api.anthropic.com");
const SKIP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding", "proxy-authorization", "te", "trailer"]);
// $/MTok (platform.claude.com pricing, 2026-09-19): input, output. Cache write 1.25x (5m) / 2x (1h), read 0.1x.
const PRICE = { sonnet: [2, 10], haiku: [1, 5], opus: [5, 25] };
const priceOf = (model) => PRICE[Object.keys(PRICE).find((k) => String(model).includes(k)) ?? "sonnet"];
function costUsd(model, u) {
  if (!u) return 0;
  const [pin, pout] = priceOf(model);
  const c = u.cache_creation ?? {};
  const w1h = c.ephemeral_1h_input_tokens ?? 0;
  const w5m = c.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h);
  return ((u.input_tokens ?? 0) * pin + w5m * pin * 1.25 + w1h * pin * 2 + (u.cache_read_input_tokens ?? 0) * pin * 0.1 + (u.output_tokens ?? 0) * pout) / 1e6;
}

let spent = 0;
const probes = [];
const forwarded = [];
const log = (s) => process.stderr.write(`[exp] ${s}\n`);

/** Structure only: where system messages sit, whether the history holds thinking blocks, which betas. */
function shapeFacts(body, headers) {
  const msgs = body.messages ?? [];
  const nonSysIdx = msgs.map((m, i) => (m.role === "system" ? -1 : i)).filter((i) => i >= 0);
  const lastNonSys = nonSysIdx.at(-1) ?? -1;
  const sys = msgs.map((m, i) => (m.role === "system" ? i : -1)).filter((i) => i >= 0);
  const thinking = msgs.filter((m) => m.role === "assistant" && Array.isArray(m.content)).flatMap((m) => m.content).filter((c) => c.type === "thinking" || c.type === "redacted_thinking").length;
  return {
    model: body.model,
    roles: msgs.map((m) => m.role[0]).join(""),
    system_positions: sys,
    system_mid_list: sys.some((i) => i < lastNonSys),
    history_thinking_blocks: thinking,
    thinking: body.thinking ?? null,
    betas: String(headers["anthropic-beta"] ?? "").split(",").filter(Boolean).length,
  };
}

/** Sends one request; for probes reads only up to message_start, then aborts. */
function send(path, headers, body, { probe }) {
  return new Promise((resolve) => {
    const h = { ...headers, host: upstream.host, "content-length": String(body.length), "accept-encoding": "identity" };
    const req = https.request({ hostname: upstream.hostname, method: "POST", path, headers: h }, (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c.toString("utf8");
        if (probe && res.statusCode < 400) {
          const m = /data: (\{"type":"message_start".*)\n/.exec(buf);
          if (m) { let usage = null; try { usage = JSON.parse(m[1]).message.usage; } catch { /* partial */ } res.destroy(); req.destroy(); resolve({ status: res.statusCode, usage }); }
        }
      });
      res.on("end", () => {
        if (res.statusCode >= 400) { let error = buf.slice(0, 300); try { error = JSON.parse(buf).error.message; } catch { /* raw */ } resolve({ status: res.statusCode, error }); }
        else resolve({ status: res.statusCode, text: buf });
      });
      res.on("error", () => resolve({ status: res.statusCode ?? 0, error: "stream error" }));
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.end(body);
  });
}

async function probe(label, path, headers, bodyBuf, fields, facts) {
  if (spent >= capUsd) { probes.push({ label, skipped: "cap reached" }); log(`skip ${label} (cap)`); return null; }
  const r = await send(path, headers, bodyBuf, { probe: true });
  const model = JSON.parse(bodyBuf.toString("utf8")).model;
  const usd = costUsd(model, r.usage);
  spent += usd;
  probes.push({ label, status: r.status, accepted: r.status === 200, error: r.error ?? null, fields, facts, usage: r.usage ?? null, est_usd: Number(usd.toFixed(5)) });
  log(`${r.status === 200 ? "ACCEPT" : "reject"} ${r.status} ${label}${r.error ? " :: " + String(r.error).slice(0, 160) : ""}  (spent ~$${spent.toFixed(3)})`);
  return r.status === 200;
}

const variantBody = (parsed, mutate) => { const b = structuredClone(parsed); mutate?.(b); return Buffer.from(JSON.stringify(b)); };
const rt = (buf, extra = {}) => retarget(buf, { from: "sonnet", to: "haiku", model: HAIKU, ...extra });

const state = { subPinned: new Set(), mainPinned: null, mainConts: 0, unpinProbed: false };

async function route(req, raw, headers) {
  const view = (() => { const r = parseRequest(req.headers, raw); return r.ok ? r.view : null; })();
  if (!view || !String(view.requestedModel).includes("sonnet") || view.toolCount === 0) return { body: raw, headers, note: "passthrough" };
  const parsed = JSON.parse(raw.toString("utf8"));
  const facts = shapeFacts(parsed, headers);

  if (view.kind === "subagent" && view.agentId) {
    const r = rt(raw);
    if (!r.ok) return { body: raw, headers, note: `rewrite_failed:${r.reason}` };
    const first = !state.subPinned.has(view.agentId);
    if (first) {
      const ok = await probe("subagent-first", req.url, headers, r.body, r.fields, facts);
      if (!ok) return { body: raw, headers, note: "subagent not routed" };
      state.subPinned.add(view.agentId);
    }
    return { body: r.body, headers, note: first ? "subagent-first routed" : "subagent-pinned", fields: r.fields, facts };
  }

  if (view.kind === "main" && view.turn === "continuation") {
    state.mainConts++;
    if (state.mainPinned === null && facts.history_thinking_blocks > 0) {
      const keep = rt(raw);
      const drop = rt(raw, { dropHistoryThinking: true });
      const okKeep = keep.ok && (await probe("main-cont1:keep-history-thinking", req.url, headers, keep.body, keep.fields, facts));
      if (drop.ok) await probe("main-cont1:drop-history-thinking", req.url, headers, drop.body, drop.fields, facts);
      const noDisplay = rt(variantBody(parsed, (b) => { if (b.thinking) delete b.thinking.display; }));
      if (noDisplay.ok) await probe("main-cont1:no-display (interactive shape)", req.url, headers, noDisplay.body, noDisplay.fields, { ...facts, thinking: { type: "adaptive" } });
      if (keep.ok) await probe("main-cont1:+redact-thinking beta (interactive header)", req.url, { ...headers, "anthropic-beta": `${headers["anthropic-beta"]},redact-thinking-2026-02-12` }, keep.body, keep.fields, facts);
      state.mainPinned = okKeep ? "keep" : "drop";
      const chosen = okKeep ? keep : drop;
      if (!chosen.ok) return { body: raw, headers, note: "main not routed" };
      return { body: chosen.body, headers, note: `main-cont1 routed (${state.mainPinned})`, fields: chosen.fields, facts };
    }
    if (state.mainPinned !== null) {
      if (!state.unpinProbed) {
        state.unpinProbed = true;
        await probe("unpin-to-sonnet (original bytes, Haiku turns in history)", req.url, headers, raw, [], facts);
      }
      const r = rt(raw, { dropHistoryThinking: state.mainPinned === "drop" });
      if (!r.ok) return { body: raw, headers, note: `rewrite_failed:${r.reason}` };
      return { body: r.body, headers, note: "main-pinned", fields: r.fields, facts };
    }
  }
  return { body: raw, headers, note: "passthrough" };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!SKIP.has(k)) headers[k] = v;
    let plan = { body: raw, headers, note: "passthrough" };
    if (req.method === "POST" && req.url.startsWith("/v1/messages") && !req.url.includes("count_tokens")) {
      try { plan = await route(req, raw, headers); } catch (e) { log(`route error ${e.message}; passthrough`); }
    }
    const up = https.request({ hostname: upstream.hostname, method: req.method, path: req.url, headers: { ...plan.headers, host: upstream.host, ...(plan.body.length ? { "content-length": String(plan.body.length) } : {}), "accept-encoding": "identity" } }, (ur) => {
      const oh = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!SKIP.has(k)) oh[k] = v;
      res.writeHead(ur.statusCode, oh);
      let text = "";
      ur.on("data", (c) => { text += c.toString("utf8"); res.write(c); });
      ur.on("end", () => {
        res.end();
        if (!req.url.startsWith("/v1/messages")) return;
        let usage = null;
        for (const m of text.matchAll(/data: (\{"type":"message_(?:start|delta)".*)\n/g)) { try { const o = JSON.parse(m[1]); usage = { ...usage, ...(o.message?.usage ?? o.usage) }; } catch { /* partial */ } }
        let model = null; try { model = JSON.parse(plan.body.toString("utf8")).model ?? null; } catch { /* not json */ }
        let error = null; if (ur.statusCode >= 400) { try { error = JSON.parse(text).error.message; } catch { error = text.slice(0, 200); } }
        const usd = costUsd(model, usage);
        spent += usd;
        forwarded.push({ note: plan.note, model, status: ur.statusCode, error, fields: plan.fields ?? [], facts: plan.facts ?? null, usage, est_usd: Number(usd.toFixed(5)) });
        log(`forward ${ur.statusCode} ${plan.note} -> ${model}${error ? " :: " + error : ""}  (spent ~$${spent.toFixed(3)})`);
      });
    });
    up.on("error", (e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e.message)); });
    up.end(plan.body);
  });
});

server.listen(0, "127.0.0.1", () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) { if (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE") continue; env[k] = v; }
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const child = spawn("claude", claudeArgs, { cwd, stdio: ["ignore", "ignore", "inherit"], env });
  child.on("exit", (code) => {
    server.close();
    writeFileSync(join(out, "results.json"), JSON.stringify({ target: HAIKU, cap_usd: capUsd, est_total_usd: Number(spent.toFixed(4)), claude_exit: code, probes, forwarded }, null, 1));
    log(`claude exited ${code}; estimated spend $${spent.toFixed(3)}; results in ${out}/results.json`);
    process.exit(0);
  });
});
