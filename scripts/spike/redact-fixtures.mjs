#!/usr/bin/env node
// Milestone 0 spike tooling — turns raw capture dumps (gitignored) into redacted, version-tagged
// fixtures under test/fixtures/claude-code/<version>/.
//
//   node scripts/spike/redact-fixtures.mjs <capture-dir> [--name-prefix p]  (see FIXTURE_PLAN below)
//
// Redaction rules:
//   * identifiers (session/agent/device/account/prompt/tool-use/uuids/org ids) -> stable placeholders
//   * home dir, username, email -> placeholders
//   * long text (system prompt, reminders, tool results, tool descriptions) is elided; lines carrying
//     detection markers are ALWAYS preserved, and the script asserts the markers survive
//   * credential headers were never written to the raw dump; organisation/request ids are masked here
//   * a final leak scan fails the run if the original identifiers or common secret shapes remain
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";

const [, , dumpDir, ...rest] = process.argv;
if (!dumpDir) { console.error("usage: redact-fixtures.mjs <capture-dir> [--label name]"); process.exit(2); }
const label = rest.includes("--label") ? rest[rest.indexOf("--label") + 1] : "run";
const extraSecrets = (process.env.REFLEX_REDACT_EXTRA ?? "").split(",").filter(Boolean); // e.g. an email address

const MARKERS = ["cc_is_subagent=true", "You are an agent for Claude Code", "x-anthropic-billing-header:", "cc_entrypoint=", "cc_version="];
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// ---- stable placeholder maps ------------------------------------------------------------------
const maps = new Map();
const alias = (kind, value) => {
  if (!maps.has(kind)) maps.set(kind, new Map());
  const m = maps.get(kind);
  if (!m.has(value)) m.set(value, `${kind}-${m.size + 1}`);
  return m.get(value);
};
const home = homedir(), user = userInfo().username;
// Identifiers are registered from the raw dump BEFORE redaction and then replaced everywhere they occur
// (tool results, hook payloads, transcripts...), not only in the field they were found in.
const KNOWN_KINDS = ["SESSION", "AGENT", "DEVICE", "ACCOUNT", "PROMPT", "REQ"];
const scrubString = (s) => {
  let o = s;
  for (const kind of KNOWN_KINDS) for (const [value, name] of maps.get(kind) ?? []) if (value.length >= 8) o = o.split(value).join(name);
  o = o.split(home).join("/Users/USER");
  if (user) o = o.replace(new RegExp(`\\b${user}\\b`, "g"), "USER");
  for (const x of extraSecrets) o = o.split(x).join("REDACTED");
  o = o.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "user@example.com");
  o = o.replace(/toolu_[A-Za-z0-9]+/g, (m) => alias("TOOLU", m));
  o = o.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, (m) => alias("UUID", m));
  o = o.replace(/\b[0-9a-f]{64}\b/g, (m) => alias("HEX64", m));
  o = o.replace(/\b(msg|req|resp)_[A-Za-z0-9]{10,}\b/g, (_, k) => `${k}_REDACTED`);
  o = o.replace(/\/private\/tmp\/claude-\d+\/[^\s"']*/g, "/private/tmp/SCRATCH");
  return o;
};

// ---- text elision that preserves marker lines --------------------------------------------------
const elide = (text, keepHead = 240) => {
  if (typeof text !== "string" || text.length <= keepHead + 40) return text;
  const lines = text.split("\n");
  const keep = new Set();
  let used = 0;
  lines.forEach((l, i) => { if (used < keepHead) { keep.add(i); used += l.length + 1; } });
  lines.forEach((l, i) => { if (MARKERS.some((m) => l.includes(m))) keep.add(i); });
  const out = []; let skipped = 0, skippedChars = 0;
  lines.forEach((l, i) => {
    if (keep.has(i)) { if (skipped) { out.push(`[…elided ${skipped} lines / ${skippedChars} chars…]`); skipped = 0; skippedChars = 0; } out.push(l); }
    else { skipped++; skippedChars += l.length + 1; }
  });
  if (skipped) out.push(`[…elided ${skipped} lines / ${skippedChars} chars…]`);
  return out.join("\n");
};

const redactBlock = (b) => {
  if (!b || typeof b !== "object") return b;
  const o = { ...b };
  if (o.type === "text" && typeof o.text === "string") {
    const isReminder = o.text.trimStart().startsWith("<system-reminder>");
    o.text = scrubString(isReminder ? elide(o.text, 120) : elide(o.text, 4000));
  }
  if (o.type === "thinking") { o.thinking = "[elided]"; if ("signature" in o) o.signature = "[elided]"; }
  if (o.type === "redacted_thinking") o.data = "[elided]";
  if (o.type === "tool_use") { o.id = scrubString(o.id); o.input = scrubDeep(o.input); }
  if (o.type === "tool_result") {
    o.tool_use_id = scrubString(o.tool_use_id);
    if (typeof o.content === "string") o.content = scrubString(elide(o.content, 300));
    else if (Array.isArray(o.content)) o.content = o.content.map(redactBlock);
  }
  if (o.cache_control) o.cache_control = { ...o.cache_control };
  return o;
};
const scrubDeep = (v) => {
  if (typeof v === "string") return scrubString(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)]));
  return v;
};

const KEEP_SCHEMA_TOOLS = new Set(["Agent", "Bash", "Edit"]);
const redactTool = (t) => {
  const keepFull = KEEP_SCHEMA_TOOLS.has(t.name) || t.name.includes("draft4") || t.name.includes("count_items");
  return {
    name: t.name,
    description: scrubString(elide(t.description ?? "", 60)),
    input_schema: keepFull ? scrubDeep(stripDescriptions(t.input_schema)) : { _elided: true, type: t.input_schema?.type, "$schema": t.input_schema?.$schema },
    ...(t.cache_control ? { cache_control: t.cache_control } : {}),
  };
};
const stripDescriptions = (s) => {
  if (Array.isArray(s)) return s.map(stripDescriptions);
  if (s && typeof s === "object") return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === "description" && typeof v === "string" ? elide(v, 60) : stripDescriptions(v)]));
  return s;
};

const redactMessage = (m) => ({ ...m, content: typeof m.content === "string" ? scrubString(elide(m.content, m.role === "system" ? 120 : 4000)) : (m.content ?? []).map(redactBlock) });

const redactSystem = (s) => (typeof s === "string" ? scrubString(elide(s, 240)) : Array.isArray(s) ? s.map(redactBlock) : s);

const redactUserId = (raw) => {
  if (typeof raw !== "string") return raw;
  try {
    const o = JSON.parse(raw);
    return JSON.stringify({ ...o, ...(o.device_id ? { device_id: alias("DEVICE", o.device_id) } : {}), ...(o.account_uuid ? { account_uuid: alias("ACCOUNT", o.account_uuid) } : {}), ...(o.session_id ? { session_id: alias("SESSION", o.session_id) } : {}) });
  } catch { return scrubString(raw); }
};

const IDENT_HEADERS = { "x-claude-code-session-id": "SESSION", "x-claude-code-agent-id": "AGENT", "x-client-request-id": "REQ" };
const MASK_HEADER = /organization|request-id|cf-ray|set-cookie|envoy|anthropic-ratelimit|retry-after/i;
const redactHeaders = (h) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k, IDENT_HEADERS[k] ? alias(IDENT_HEADERS[k], String(v)) : MASK_HEADER.test(k) ? "[redacted]" : scrubString(String(v))]));

const redactRequest = (q) => {
  const b = q.body && typeof q.body === "object" ? q.body : q.body;
  return {
    method: q.method, url: q.url, headers: redactHeaders(q.headers),
    body: b && typeof b === "object" && Array.isArray(b.messages) ? {
      ...b,
      system: redactSystem(b.system),
      messages: b.messages.map(redactMessage),
      tools: (b.tools ?? []).map(redactTool),
      metadata: b.metadata ? { ...b.metadata, user_id: redactUserId(b.metadata.user_id) } : b.metadata,
    } : b,
  };
};

const truncateSse = (text, max = 12000) => {
  if (text.length <= max) return scrubString(text);
  const cut = text.lastIndexOf("\n\n", max);
  return scrubString(text.slice(0, cut > 0 ? cut + 2 : max)) + "[…truncated…]\n";
};

// ---- structural facts used for self-checks ---------------------------------------------------
const sysText = (b) => (typeof b?.system === "string" ? b.system : Array.isArray(b?.system) ? b.system.map((x) => x?.text ?? "").join("\n") : "");
const facts = (b) => ({ S1: sysText(b).includes("cc_is_subagent=true"), S2: sysText(b).includes("You are an agent for Claude Code"), S3: sysText(b).includes("x-anthropic-billing-header:"), cc_version: /cc_version=([^;\s]+)/.exec(sysText(b))?.[1], entrypoint: /cc_entrypoint=([^;\s]+)/.exec(sysText(b))?.[1] });
const blocksOf = (m) => (typeof m?.content === "string" ? [{ type: "text", text: m.content }] : m?.content ?? []);

// ---- main --------------------------------------------------------------------------------------
const registerKnown = (dir) => {
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".req.json")) {
      const q = readJson(join(dir, f));
      for (const [k, kind] of Object.entries(IDENT_HEADERS)) if (q.headers?.[k]) alias(kind, String(q.headers[k]));
      const uid = q.body?.metadata?.user_id;
      if (typeof uid === "string") { try { const o = JSON.parse(uid); if (o.device_id) alias("DEVICE", o.device_id); if (o.account_uuid) alias("ACCOUNT", o.account_uuid); if (o.session_id) alias("SESSION", o.session_id); } catch { /* not json */ } }
    }
  }
  const hp = join(dir, "hooks.jsonl");
  if (existsSync(hp)) for (const l of readFileSync(hp, "utf8").split("\n").filter(Boolean)) { const h = JSON.parse(l).body; if (h.session_id) alias("SESSION", h.session_id); if (h.agent_id) alias("AGENT", h.agent_id); if (h.prompt_id) alias("PROMPT", h.prompt_id); }
};
registerKnown(dumpDir);
const reqFiles = readdirSync(dumpDir).filter((f) => f.endsWith(".req.json")).sort();
const first = readJson(join(dumpDir, reqFiles.find((f) => f.includes("POST-v1_messages"))));
const version = /claude-cli\/([0-9.]+)/.exec(first.headers?.["user-agent"] ?? "")?.[1];
if (!version) { console.error("cannot determine claude version from user-agent"); process.exit(1); }
const outDir = join("test", "fixtures", "claude-code", version);
mkdirSync(outDir, { recursive: true });

const written = [];
const write = (name, obj, description, extra = {}) => {
  const path = join(outDir, name);
  writeFileSync(path, typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) + "\n");
  written.push({ file: name, description, ...extra });
};

// Classify each POST /v1/messages request so fixtures are chosen by shape, not by index.
const messages = reqFiles.filter((f) => f.includes("POST-v1_messages")).map((f) => ({ f, q: readJson(join(dumpDir, f)), res: existsSync(join(dumpDir, f.replace(".req.", ".res."))) ? readJson(join(dumpDir, f.replace(".req.", ".res."))) : null }));
const isSub = (x) => !!x.q.headers?.["x-claude-code-agent-id"];
const lastNonSys = (x) => x.q.body.messages.filter((m) => m.role !== "system").at(-1);
const hasResult = (x) => blocksOf(lastNonSys(x)).some((b) => b.type === "tool_result");
const hasErrResult = (x) => blocksOf(lastNonSys(x)).some((b) => b.type === "tool_result" && b.is_error === true);
const pickFirst = (pred) => messages.find(pred);
const plan = [
  ["main-new-turn", pickFirst((x) => !isSub(x) && !hasResult(x)), "main chat, first request of a user turn (last message: user text + system-reminders; trailing role:system message)"],
  ["subagent-new-turn", pickFirst((x) => isSub(x) && !hasResult(x)), "subagent, first request (delegation prompt as user text)"],
  ["subagent-continuation", pickFirst((x) => isSub(x) && hasResult(x)), "subagent, tool-loop continuation (last non-system message is a tool_result)"],
  ["main-continuation", pickFirst((x) => !isSub(x) && hasResult(x)), "main chat, tool-loop continuation"],
  ["main-continuation-tool-error", pickFirst((x) => !isSub(x) && hasErrResult(x)), "main chat, continuation whose tool_result has is_error=true (failed Bash)"],
];
const summaryFacts = {};
for (const [name, x, desc] of plan) {
  if (!x) { console.warn(`[skip] ${label}: no request matches ${name}`); continue; }
  const before = facts(x.q.body);
  const red = redactRequest(x.q);
  const after = facts(red.body);
  if (JSON.stringify(before) !== JSON.stringify(after)) { console.error(`FAIL: markers changed by redaction in ${name}`, before, after); process.exit(1); }
  write(`${label}.${name}.request.json`, red, desc, { facts: after, agent_scoped: isSub(x) });
  summaryFacts[name] = after;
  if (name === "subagent-new-turn" && x.res) write(`${label}.${name}.response.sse.txt`, truncateSse(x.res.body_head), "SSE response of a subagent request (LF-separated, identity-encoded because the capture proxy drops accept-encoding)", { status: x.res.status, response_headers: redactHeaders(x.res.headers) });
}
// native model shape: a request whose model differs from the first one (used for capability table)
const head = reqFiles.find((f) => f.includes("HEAD"));
if (head) { const r = readJson(join(dumpDir, head)); const rr = readJson(join(dumpDir, head.replace(".req.", ".res."))); write(`${label}.head-probe.json`, { request: { method: r.method, url: r.url, headers: redactHeaders(r.headers) }, response_status: rr.status }, "startup probe Claude Code sends to the base URL"); }
const hookPath = join(dumpDir, "hooks.jsonl");
if (existsSync(hookPath)) {
  const evs = readFileSync(hookPath, "utf8").split("\n").filter(Boolean).map((l) => scrubHookEvent(JSON.parse(l).body));
  write(`${label}.hooks.jsonl`, evs.map((e) => JSON.stringify(e)).join("\n") + "\n", "hook payloads delivered by http hooks injected with --settings (one JSON per line, in arrival order)", { events: evs.map((e) => e.hook_event_name + (e.tool_name ? ":" + e.tool_name : "") + (e.agent_id ? "(sub)" : "")) });
}
function scrubHookEvent(h) {
  const o = scrubDeep(h);
  for (const k of ["session_id"]) if (h[k]) o[k] = alias("SESSION", h[k]);
  if (h.agent_id) o.agent_id = alias("AGENT", h.agent_id);
  if (h.prompt_id) o.prompt_id = alias("PROMPT", h.prompt_id);
  for (const k of ["transcript_path", "agent_transcript_path"]) if (h[k]) o[k] = scrubString(String(h[k]).replace(/\/projects\/[^/]+\//, "/projects/PROJECT/"));
  if (o.last_assistant_message) o.last_assistant_message = elide(o.last_assistant_message, 200);
  if (o.tool_response && typeof o.tool_response === "object") for (const k of ["originalFile", "stdout", "stderr"]) if (typeof o.tool_response[k] === "string") o.tool_response[k] = elide(o.tool_response[k], 200);
  return o;
}

// ---- manifest + leak scan ----------------------------------------------------------------------
const manifestPath = join(outDir, "manifest.json");
const prior = existsSync(manifestPath) ? readJson(manifestPath) : { files: [] };
const merged = [...prior.files.filter((f) => !written.some((w) => w.file === f.file)), ...written];
writeFileSync(manifestPath, JSON.stringify({
  claude_code_version: version,
  captured_at: new Date().toISOString().slice(0, 10),
  platform: process.platform,
  entrypoint: [...new Set(Object.values(summaryFacts).map((f) => f.entrypoint))].join(",") || prior.entrypoint,
  method: "scripts/spike/capture.mjs (dump-only passthrough proxy) + scripts/spike/redact-fixtures.mjs; claude -p (non-interactive)",
  gaps: ["interactive TUI (cc_entrypoint=cli) not captured", "no fork / background / parallel-agent runs", "models seen: see request files", "single OS (macOS)"],
  files: merged,
}, null, 1) + "\n");

const secrets = [home, user, ...extraSecrets, ...[...(maps.get("UUID") ?? new Map()).keys(), ...(maps.get("SESSION") ?? new Map()).keys(), ...(maps.get("AGENT") ?? new Map()).keys(), ...(maps.get("DEVICE") ?? new Map()).keys(), ...(maps.get("ACCOUNT") ?? new Map()).keys()]].filter((s) => s && s.length >= 4);
const shapes = [/sk-ant-[A-Za-z0-9_-]{10,}/, /apikey_[A-Za-z0-9]{8,}/, /Bearer\s+[A-Za-z0-9._-]{16,}/i, /ghp_[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./];
let leaks = 0;
for (const f of readdirSync(outDir)) {
  const text = readFileSync(join(outDir, f), "utf8");
  for (const s of secrets) if (text.includes(s)) { console.error(`LEAK: ${f} contains original identifier "${s.slice(0, 6)}…"`); leaks++; }
  for (const re of shapes) if (re.test(text)) { console.error(`LEAK: ${f} matches secret shape ${re}`); leaks++; }
}
if (leaks) { console.error(`${leaks} leak(s) — fixtures NOT safe to commit`); process.exit(1); }
console.log(`OK ${label}: wrote ${written.length} files to ${outDir} (claude ${version}); markers preserved; leak scan clean`);
console.log(JSON.stringify(summaryFacts));
