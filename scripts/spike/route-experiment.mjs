#!/usr/bin/env node
// Spike (not product code): does the API accept Claude Code requests retargeted by src/wire/rewrite.ts in the shapes
// route mode will actually produce? One real `claude -p` session (source model: --from, sonnet or opus) is routed
// through this proxy the way route mode would route it, and at each interesting point extra PROBES are sent to every
// cheaper target tier (or to the tiers named by --to, e.g. `--from haiku --to sonnet,opus` for upgrades):
//
//   main-new:<t>          the main chat's first request (no history), rewritten to <t>; not routed, only probed
//   subagent-first:<t>    each subagent's first request, rewritten to <t>; subagent #1 is then pinned to the
//                         cheapest target, subagent #2 to the next one (so each target gets a pinned continuation)
//   subagent-pinned:<t>   later subagent requests, rewritten (target-made history, client still asks for --from)
//   main-cont1:<t>:*      first main-chat continuation: source-model thinking + tool_use in history, system messages
//                         mid-list and trailing. Variants: keep history thinking / drop it / no `display`
//                         (interactive shape) / + redact-thinking beta (interactive header)
//   main-pinned           later main continuations rewritten to the main target (history now holds its turns)
//   unpin-to-source       the same later request sent UNCHANGED to the source model (the retry-with-original / pin
//                         release case: target-made thinking in a source-model request)
//
//   node --import tsx scripts/spike/route-experiment.mjs --from opus --out DIR --cap-usd 0.40 -- <claude args>
//
// Options: --to a,b (targets instead of the cheaper tiers) · --main <tier> (the main chat's pin) · --no-main-new ·
// --probe-1m (first request + context-1m beta) · --probe-efforts (first request at each effort) · --probe-ceiling
// (first request padded to the Haiku ceiling, sent to Haiku) · --delay-pin (decide a subagent at its second request) ·
// --interactive <exit-s> (TUI in a pseudo-terminal via pty-run.py). Probes and routed requests carry the product's
// header rewrite (STRIP_BETAS). The cap is checked before each probe, not against its cost: one large probe can
// overshoot it.
//
// Headers of the live request (auth included) are held in memory only and never written. Probes stop reading at
// `message_start` (enough for status and input usage) and are aborted. Recorded per probe: status, API error
// message, shape facts, rewritten fields, usage and an estimated cost. No prompt text is recorded.
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "../../src/wire/claude-code.ts";
import { retarget, retargetBetas } from "../../src/wire/rewrite.ts";
import { CONTEXT_CEILING, estimateTokens } from "../../src/tiers.ts";

const argv = process.argv.slice(2);
let out = join("_dumps", "route-exp-" + Date.now());
let capUsd = 0.45;
let cwd = process.cwd();
let from = "sonnet";
let to = null;
let mainTarget = null;
let noMainNew = false;
/** Also probe each main-new target with the long-context beta added (a `<model>[1m]` setting sends it). */
let probe1m = false;
/** Also probe each main-new target that takes `effort` with low / medium / high / xhigh / max. */
let probeEfforts = false;
/** Also send the main-new request, padded to route mode's Haiku context ceiling (estimated tokens), to Haiku. */
let probeCeiling = false;
/** Let each subagent's first request through unchanged, so its second request holds a source-model turn; decide there. */
let delayPin = false;
/** Run the TUI in a pseudo-terminal (scripts/spike/pty-run.py), type the -p prompt, and /exit after this many seconds. */
let interactiveExitS = null;
const claudeArgs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") out = argv[++i];
  else if (argv[i] === "--cap-usd") capUsd = Number(argv[++i]);
  else if (argv[i] === "--cwd") cwd = argv[++i];
  else if (argv[i] === "--from") from = argv[++i];
  else if (argv[i] === "--to") to = argv[++i].split(",");
  else if (argv[i] === "--main") mainTarget = argv[++i];
  else if (argv[i] === "--no-main-new") noMainNew = true;
  else if (argv[i] === "--probe-1m") probe1m = true;
  else if (argv[i] === "--probe-efforts") probeEfforts = true;
  else if (argv[i] === "--probe-ceiling") probeCeiling = true;
  else if (argv[i] === "--delay-pin") delayPin = true;
  else if (argv[i] === "--interactive") interactiveExitS = Number(argv[++i]);
  else if (argv[i] === "--") { claudeArgs.push(...argv.slice(i + 1)); break; }
}
mkdirSync(out, { recursive: true, mode: 0o700 });

const MODELS = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-5", opus: "claude-opus-5", fable: "claude-fable-5-1" };
const ORDER = ["haiku", "sonnet", "opus", "fable"];
/** --to, or else the cheaper tiers than the source; cheapest first. */
const TARGETS = to ?? ORDER.slice(0, ORDER.indexOf(from));
const MAIN_TARGET = mainTarget ?? TARGETS[0];
const upstream = new URL("https://api.anthropic.com");
const SKIP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding", "proxy-authorization", "te", "trailer"]);
// $/MTok (platform.claude.com pricing, 2026-09-19): input, output. Cache write 1.25x (5m) / 2x (1h), read 0.1x.
const PRICE = { sonnet: [2, 10], haiku: [1, 5], opus: [5, 25], fable: [10, 50] };
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
    effort: body.output_config?.effort ?? null,
    max_tokens: body.max_tokens ?? null,
    betas: String(headers["anthropic-beta"] ?? "").split(",").map((x) => x.trim()).filter(Boolean),
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

/** The headers route mode would send with `body`: the product's per-target beta removals (STRIP_BETAS) when retargeted. */
function productHeaders(headers, body) {
  let model = null;
  try { model = JSON.parse(body.toString("utf8")).model; } catch { return { headers, stripped: [] }; }
  const tier = Object.keys(MODELS).find((k) => MODELS[k] === model);
  if (!tier || tier === from) return { headers, stripped: [] };
  const b = retargetBetas(headers["anthropic-beta"], tier);
  return b.stripped.length === 0 ? { headers, stripped: [] } : { headers: { ...headers, "anthropic-beta": b.value }, stripped: b.stripped };
}

async function probe(label, path, rawHeaders, bodyBuf, rawFields, facts, { keepHeaders = false } = {}) {
  if (spent >= capUsd) { probes.push({ label, skipped: "cap reached" }); log(`skip ${label} (cap)`); return null; }
  const { headers, stripped } = keepHeaders ? { headers: rawHeaders, stripped: [] } : productHeaders(rawHeaders, bodyBuf);
  const fields = [...rawFields, ...stripped.map((x) => `anthropic-beta:-${x}`)];
  const r = await send(path, headers, bodyBuf, { probe: true });
  const model = JSON.parse(bodyBuf.toString("utf8")).model;
  const usd = costUsd(model, r.usage);
  spent += usd;
  probes.push({ label, status: r.status, accepted: r.status === 200, error: r.error ?? null, fields, facts, usage: r.usage ?? null, est_usd: Number(usd.toFixed(5)) });
  log(`${r.status === 200 ? "ACCEPT" : "reject"} ${r.status} ${label}${r.error ? " :: " + String(r.error).slice(0, 160) : ""}  (spent ~$${spent.toFixed(3)})`);
  return r.status === 200;
}

const variantBody = (parsed, mutate) => { const b = structuredClone(parsed); mutate?.(b); return Buffer.from(JSON.stringify(b)); };
const rt = (buf, to, extra = {}) => retarget(buf, { from, to, model: MODELS[to], ...extra });

/**
 * Pads the last user text block with synthetic filler (never user text) until the body is estimated at exactly the Haiku
 * ceiling, then sends it to Haiku: does the byte-based estimate keep a request inside Haiku's real 200k window? Three
 * fillers with different bytes-per-token: English prose, code, and dense digits/punctuation (the worst case).
 */
const FILLERS = {
  prose: "The quarterly report describes how the team moved the service to a new region, what broke, and what they changed afterwards. ",
  code: "export function f(a: number, b: string[]): Record<string, number> { return Object.fromEntries(b.map((x, i) => [x, a + i])); }\n",
  dense: "7,3;9.1|4-8=2+6*0/5^1%3#9@2!4?8~6&0 ",
  // A realistic dense case: this repository's own lockfile (public, no user text), as a Read tool result would carry it.
  lockfile: readFileSync(join(import.meta.dirname, "..", "..", "package-lock.json"), "utf8"),
};
async function ceilingProbes(req, raw, headers, facts) {
  const ceiling = CONTEXT_CEILING.haiku;
  for (const [kind, unit] of Object.entries(FILLERS)) {
    const b = JSON.parse(raw.toString("utf8"));
    const last = [...b.messages].reverse().find((m) => m.role === "user");
    if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
    const block = { type: "text", text: "" };
    last.content.push(block);
    const base = Buffer.byteLength(JSON.stringify(b));
    const need = ceiling * 2.5 - base;
    block.text = unit.repeat(Math.ceil(need / Buffer.byteLength(JSON.stringify(unit)) + 1));
    let body = Buffer.from(JSON.stringify(b));
    while (estimateTokens(body.length) > ceiling) { block.text = block.text.slice(0, -50); body = Buffer.from(JSON.stringify(b)); }
    let send = body;
    let fields = [];
    if (from !== "haiku") { const r = rt(body, "haiku"); if (!r.ok) continue; send = r.body; fields = r.fields; }
    await probe(`ceiling:${kind} (est ${estimateTokens(send.length)} tokens, ${send.length} bytes) -> haiku`, req.url, headers, send, fields, { ...facts, body_bytes: send.length, est_tokens: estimateTokens(send.length), filler: kind });
  }
}

const state = { subTarget: new Map(), subCount: 0, mainPinned: null, unpinProbed: false, crossProbed: false, mainNewProbed: false, subUnpinProbed: new Set(), subDelayed: new Set() };
/** What the run was made under (CLAUDE.md: real-API experiments record their settings). */
const seen = { requested_models: new Set(), entrypoints: new Set(), betas: new Set() };

async function route(req, raw, headers) {
  const view = (() => { const r = parseRequest(req.headers, raw); return r.ok ? r.view : null; })();
  if (!view || !String(view.requestedModel).includes(from) || view.toolCount === 0) return { body: raw, headers, note: "passthrough" };
  const parsed = JSON.parse(raw.toString("utf8"));
  const facts = shapeFacts(parsed, headers);
  seen.requested_models.add(view.requestedModel);
  seen.entrypoints.add(view.entrypoint);
  for (const b of facts.betas) seen.betas.add(b);

  if (view.kind === "main" && view.turn === "new" && !state.mainNewProbed && !noMainNew) {
    state.mainNewProbed = true;
    for (const t of TARGETS) {
      const r = rt(raw, t);
      if (r.ok) await probe(`main-new:${t}`, req.url, headers, r.body, r.fields, facts);
      if (r.ok && productHeaders(headers, r.body).stripped.length > 0) await probe(`main-new:${t}:betas untouched`, req.url, headers, r.body, r.fields, facts, { keepHeaders: true });
      if (r.ok && probeEfforts && t !== "haiku") {
        for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
          const b = JSON.parse(r.body.toString("utf8"));
          b.output_config = { ...b.output_config, effort };
          await probe(`main-new:${t}:effort=${effort}`, req.url, headers, Buffer.from(JSON.stringify(b)), [...r.fields, `output_config.effort=${effort}`], { ...facts, effort });
        }
      }
      const beta = String(headers["anthropic-beta"] ?? "");
      if (r.ok && probe1m && !beta.includes("context-1m-")) {
        await probe(`main-new:${t}:+context-1m beta`, req.url, { ...headers, "anthropic-beta": `${beta},context-1m-2025-08-07` }, r.body, r.fields, { ...facts, betas: [...facts.betas, "context-1m-2025-08-07"] });
      }
    }
    if (probeCeiling) await ceilingProbes(req, raw, headers, facts);
    return { body: raw, headers, note: "main-new passthrough" };
  }

  if (view.kind === "subagent" && view.agentId) {
    let target = state.subTarget.get(view.agentId);
    if (target === undefined && delayPin && !state.subDelayed.has(view.agentId)) {
      state.subDelayed.add(view.agentId);
      for (const t of TARGETS) {
        const r = rt(raw, t);
        if (r.ok) await probe(`subagent-first-no-history:${t}`, req.url, headers, r.body, r.fields, facts);
      }
      return { body: raw, headers, note: "subagent-first passthrough (delay-pin)", facts };
    }
    if (target === undefined) {
      // Probe every target on the first request; pin this subagent to the next target in turn.
      for (const t of TARGETS) {
        const r = rt(raw, t);
        if (r.ok) await probe(`subagent-first:${t}`, req.url, headers, r.body, r.fields, facts);
      }
      target = TARGETS[Math.min(state.subCount++, TARGETS.length - 1)];
      state.subTarget.set(view.agentId, target);
      const r = rt(raw, target);
      return r.ok ? { body: r.body, headers, note: `subagent-first routed:${target}`, fields: r.fields, facts } : { body: raw, headers, note: `rewrite_failed:${r.reason}` };
    }
    if (!state.subUnpinProbed.has(view.agentId)) {
      // The retry-with-original / pin release case for a subagent: its original bytes, now with target-made turns.
      state.subUnpinProbed.add(view.agentId);
      await probe(`subagent-unpin-to-${from} (original bytes, ${target}-made turns in history)`, req.url, headers, raw, [], facts);
    }
    const r = rt(raw, target);
    return r.ok ? { body: r.body, headers, note: `subagent-pinned:${target}`, fields: r.fields, facts } : { body: raw, headers, note: `rewrite_failed:${r.reason}` };
  }

  if (view.kind === "main" && view.turn === "continuation") {
    if (state.mainPinned === null && facts.history_thinking_blocks > 0) {
      for (const t of TARGETS) {
        const keep = rt(raw, t);
        if (keep.ok) await probe(`main-cont1:${t}:keep-history-thinking`, req.url, headers, keep.body, keep.fields, facts);
        const drop = rt(raw, t, { dropHistoryThinking: true });
        if (drop.ok) await probe(`main-cont1:${t}:drop-history-thinking`, req.url, headers, drop.body, drop.fields, facts);
        const noDisplay = rt(variantBody(parsed, (b) => { if (b.thinking) delete b.thinking.display; }), t);
        if (noDisplay.ok) await probe(`main-cont1:${t}:no-display (interactive shape)`, req.url, headers, noDisplay.body, noDisplay.fields, { ...facts, thinking: { type: parsed.thinking?.type } });
        if (keep.ok) await probe(`main-cont1:${t}:+redact-thinking beta (interactive header)`, req.url, { ...headers, "anthropic-beta": `${headers["anthropic-beta"]},redact-thinking-2026-02-12` }, keep.body, keep.fields, facts);
      }
      const chosen = rt(raw, MAIN_TARGET);
      if (!chosen.ok) return { body: raw, headers, note: "main not routed" };
      state.mainPinned = MAIN_TARGET;
      return { body: chosen.body, headers, note: `main-cont1 routed:${MAIN_TARGET}`, fields: chosen.fields, facts };
    }
    if (state.mainPinned !== null) {
      if (!state.unpinProbed) {
        state.unpinProbed = true;
        await probe(`unpin-to-${from} (original bytes, ${state.mainPinned}-made turns in history)`, req.url, headers, raw, [], facts);
        // A pinned loop whose tier is later changed (another target, e.g. after a tier is disabled mid-loop).
        for (const t of TARGETS.filter((x) => x !== state.mainPinned)) {
          const r = rt(raw, t);
          if (r.ok) await probe(`cross-target:${t} (history made by ${from} and ${state.mainPinned})`, req.url, headers, r.body, r.fields, facts);
        }
      }
      const r = rt(raw, state.mainPinned);
      if (!r.ok) return { body: raw, headers, note: `rewrite_failed:${r.reason}` };
      return { body: r.body, headers, note: `main-pinned:${state.mainPinned}`, fields: r.fields, facts };
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
    if (plan.note !== "passthrough") { const ph = productHeaders(plan.headers, plan.body); plan = { ...plan, headers: ph.headers, fields: [...(plan.fields ?? []), ...ph.stripped.map((x) => `anthropic-beta:-${x}`)] }; }
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
  let child;
  if (interactiveExitS === null) child = spawn("claude", claudeArgs, { cwd, stdio: ["ignore", "ignore", "inherit"], env });
  else {
    // The TUI: Enter at 5 s accepts a folder-trust dialog if one is shown (a no-op on an empty prompt otherwise).
    const i = claudeArgs.indexOf("-p");
    const prompt = claudeArgs[i + 1];
    const rest = claudeArgs.filter((_, k) => k !== i && k !== i + 1);
    const keys = ["5", "\\r", "10", prompt, "12", "\\r", String(interactiveExitS), "/exit", String(interactiveExitS + 3), "\\r"];
    child = spawn("python3", [join(import.meta.dirname, "pty-run.py"), ...keys, "--", "claude", ...rest], { cwd, stdio: ["ignore", "ignore", "inherit"], env });
  }
  child.on("exit", (code) => {
    server.close();
    let modelSetting = null;
    try { modelSetting = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")).model ?? null; } catch { /* none */ }
    const settings = { model_setting: modelSetting, claude_args: claudeArgs.map((a, i) => (claudeArgs[i - 1] === "-p" ? "<prompt>" : a)), requested_models: [...seen.requested_models], entrypoints: [...seen.entrypoints], betas_seen: [...seen.betas].sort() };
    writeFileSync(join(out, "results.json"), JSON.stringify({ from, targets: TARGETS, settings, cap_usd: capUsd, est_total_usd: Number(spent.toFixed(4)), claude_exit: code, probes, forwarded }, null, 1));
    log(`claude exited ${code}; estimated spend $${spent.toFixed(3)}; results in ${out}/results.json`);
    process.exit(0);
  });
});
