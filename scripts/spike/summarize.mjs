#!/usr/bin/env node
// Milestone 0 spike — structural summary of a capture dir. Prints shapes, never full prompts.
//   node scripts/spike/summarize.mjs _dumps/run1
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) { console.error("usage: summarize.mjs <capture-dir>"); process.exit(2); }
const rj = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const short = (s, n = 8) => (typeof s === "string" ? s.slice(0, n) : String(s));

const sysText = (b) => {
  const s = b?.system;
  if (typeof s === "string") return s;
  if (Array.isArray(s)) return s.map((x) => x?.text ?? "").join("\n");
  return "";
};
const blocks = (m) => (typeof m?.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m?.content) ? m.content : []);
const userIdInfo = (b) => {
  const raw = b?.metadata?.user_id;
  if (raw === undefined) return { present: false };
  try {
    const o = JSON.parse(raw);
    return { present: true, format: "json", keys: Object.keys(o), session_id: o.session_id };
  } catch {
    const m = /session_([0-9a-f-]{36})/.exec(raw);
    return { present: true, format: "string", shape: raw.replace(/[0-9a-f]{8,}/gi, "<hex>"), session_id: m?.[1] };
  }
};

const reqs = readdirSync(dir).filter((f) => f.endsWith(".req.json")).sort();
const wireSessions = new Set();
console.log(`# ${reqs.length} requests in ${dir}\n`);
for (const f of reqs) {
  const q = rj(f);
  const resFile = f.replace(".req.json", ".res.json");
  const r = existsSync(join(dir, resFile)) ? rj(resFile) : null;
  const b = q.body && typeof q.body === "object" ? q.body : null;
  const line = { n: f.slice(0, 3), method: q.method, url: q.url, bytes: q.body_bytes, status: r?.status };
  if (b && Array.isArray(b.messages)) {
    const text = sysText(b);
    const last = b.messages.at(-1);
    const lastBlocks = blocks(last);
    const uid = userIdInfo(b);
    if (uid.session_id) wireSessions.add(uid.session_id);
    const billing = /x-anthropic-billing-header:[^\n]*/.exec(text)?.[0];
    Object.assign(line, {
      model: b.model, stream: b.stream, msgs: b.messages.length, tools: b.tools?.length ?? 0,
      tool_names: (b.tools ?? []).map((t) => t.name).join(","),
      S1_cc_is_subagent: text.includes("cc_is_subagent=true"),
      S2_agent_for_cc: text.includes("You are an agent for Claude Code"),
      S3_billing_hdr: text.includes("x-anthropic-billing-header:"),
      billing_line: billing,
      sys_blocks: Array.isArray(b.system) ? b.system.length : typeof b.system,
      sys_head: text.slice(0, 90).replace(/\s+/g, " "),
      first_role: b.messages[0]?.role, last_role: last?.role,
      last_block_types: lastBlocks.map((x) => x.type).join(","),
      last_text_head: lastBlocks.filter((x) => x.type === "text").map((x) => (x.text ?? "").slice(0, 60).replace(/\s+/g, " ")).join(" | "),
      top_keys: Object.keys(b).join(","),
      thinking: b.thinking, output_config: b.output_config, ctx_mgmt: b.context_management ? Object.keys(b.context_management) : undefined,
      user_id: uid,
    });
  }
  const beta = q.headers?.["anthropic-beta"];
  if (beta) line.anthropic_beta = beta;
  if (r?.body_head) {
    const usage = [...r.body_head.matchAll(/"usage":\{[^}]*\}/g)].map((m) => m[0]).slice(-1)[0];
    const model = /"model":"([^"]+)"/.exec(r.body_head)?.[1];
    Object.assign(line, { served_model: model, usage });
  }
  console.log(JSON.stringify(line));
}

console.log("\n# request header names on first /v1/messages (values only for non-identifying ones)");
const first = reqs.find((f) => rj(f).url?.startsWith("/v1/messages"));
if (first) {
  const h = rj(first).headers;
  const showVal = new Set(["content-type", "anthropic-version", "anthropic-beta", "x-app", "user-agent", "accept"]);
  for (const [k, v] of Object.entries(h)) console.log(`${k}${showVal.has(k) ? ": " + v : k.toLowerCase().includes("session") || k.toLowerCase().includes("id") ? ": <" + String(v).length + " chars>" : ""}`);
}

console.log("\n# hooks");
const hp = join(dir, "hooks.jsonl");
const hookSessions = new Set();
if (existsSync(hp)) {
  for (const l of readFileSync(hp, "utf8").split("\n").filter(Boolean)) {
    const { body: h } = JSON.parse(l);
    if (h.session_id) hookSessions.add(h.session_id);
    const bash = h.tool_name === "Bash" ? { cmd: String(h.tool_input?.command).slice(0, 40), resp_keys: h.tool_response && Object.keys(h.tool_response), error: h.error && String(h.error).slice(0, 40), is_interrupt: h.is_interrupt } : undefined;
    const edit = h.tool_name === "Edit" ? { input_keys: Object.keys(h.tool_input ?? {}), resp_keys: h.tool_response && Object.keys(h.tool_response) } : undefined;
    console.log(JSON.stringify({
      ev: h.hook_event_name, sid: short(h.session_id), agent_id: h.agent_id && short(h.agent_id, 12), agent_type: h.agent_type,
      tool: h.tool_name, tool_use_id: h.tool_use_id && short(h.tool_use_id, 14), prompt_id: h.prompt_id && short(h.prompt_id),
      extra_keys: Object.keys(h).filter((k) => !["session_id", "transcript_path", "cwd", "hook_event_name", "permission_mode", "tool_name", "tool_input", "tool_response", "tool_use_id", "duration_ms", "agent_id", "agent_type", "prompt_id", "effort"].includes(k)).join(","),
      bash, edit,
    }));
  }
}

console.log("\n# session id correlation");
console.log(JSON.stringify({ wire_session_ids: [...wireSessions].map((s) => short(s)), hook_session_ids: [...hookSessions].map((s) => short(s)), equal_sets: wireSessions.size > 0 && [...wireSessions].every((s) => hookSessions.has(s)) && [...hookSessions].every((s) => wireSessions.has(s)), overlap: [...wireSessions].filter((s) => hookSessions.has(s)).length }));
