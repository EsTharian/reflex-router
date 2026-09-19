#!/usr/bin/env node
// Spike (not product code): what would outcome capture have recorded for sessions that ran before it existed?
// Reads the decision logs (current + ~/.reflex/archive/*.jsonl), finds the Claude Code transcripts of those
// sessions (~/.claude/projects/*/<session-id>.jsonl, matched by the same session hash the log uses), converts each
// transcript into the hook events Claude Code would have sent (UserPromptSubmit, PostToolUse, PostToolUseFailure for
// Edit/Write/MultiEdit/Bash), and feeds them through the product OutcomeTracker together with the logged decisions.
// Main chat only (subagent transcripts are separate files). Prints counts, scores and rule ids; never text.
//
//   node --import tsx scripts/spike/replay-transcripts.mjs
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { OutcomeTracker } from "../../src/outcome/tracker.ts";
import { hashId } from "../../src/log/decision-log.ts";

const reflex = join(homedir(), ".reflex");
const logs = [join(reflex, "decisions.jsonl"), ...(existsSync(join(reflex, "archive")) ? readdirSync(join(reflex, "archive")).map((f) => join(reflex, "archive", f)) : [])].filter(existsSync);
const decisions = new Map(); // session hash -> [{label, rec}]
for (const f of logs) {
  for (const l of readFileSync(f, "utf8").trim().split("\n")) {
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    if ((r.record ?? "decision") !== "decision" || !r.session) continue;
    if (!decisions.has(r.session)) decisions.set(r.session, []);
    decisions.get(r.session).push({ label: basename(f, ".jsonl"), rec: r });
  }
}

const projects = join(homedir(), ".claude", "projects");
const transcripts = [];
for (const d of readdirSync(projects)) {
  const dir = join(projects, d);
  if (!statSync(dir).isDirectory()) continue;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    const id = f.replace(/\.jsonl$/, "");
    if (decisions.has(hashId(id))) transcripts.push({ id, file: join(dir, f) });
  }
}

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "");
const EDIT = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

for (const { id, file } of transcripts.sort((a, b) => a.file.localeCompare(b.file))) {
  const entries = readFileSync(file, "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const out = [];
  let clock = 0;
  const tracker = new OutcomeTracker({ emit: (r) => out.push(r), now: () => clock });
  const toolUses = new Map();
  const events = [];
  let prompts = 0;
  for (const e of entries) {
    const at = Date.parse(e.timestamp ?? "") || null;
    if (at === null) continue;
    const c = e.message?.content;
    if (e.type === "user" && !e.isMeta && !e.isSidechain) {
      const results = Array.isArray(c) ? c.filter((b) => b.type === "tool_result") : [];
      if (results.length === 0) {
        const t = textOf(c).trim();
        // A submission the user typed (turnOrigin/origin "human") fires UserPromptSubmit even when it is a slash command
        // that expands into a prompt; local command output and bash-mode echoes do not.
        const human = e.turnOrigin === "human" || e.origin?.kind === "human";
        if (t === "" || (!human && /^<(local-command|command-name|command-message|bash-)/.test(t))) continue;
        prompts++;
        events.push({ at, ev: { type: "UserPromptSubmit", base: { sessionId: id, promptId: e.promptId ?? null, agentId: null }, prompt: t } });
      }
      for (const r of results) {
        const u = toolUses.get(r.tool_use_id);
        if (!u || (!EDIT.has(u.name) && u.name !== "Bash")) continue;
        const input = u.input ?? {};
        const edits = u.name === "Edit" ? [{ oldText: input.old_string ?? null, newText: input.new_string ?? "" }] : u.name === "Write" ? [{ oldText: null, newText: input.content ?? "" }] : u.name === "MultiEdit" ? (input.edits ?? []).map((x) => ({ oldText: x.old_string ?? null, newText: x.new_string ?? "" })) : [];
        const originalFile = typeof e.toolUseResult === "object" && e.toolUseResult && typeof e.toolUseResult.originalFile === "string" ? e.toolUseResult.originalFile : null;
        events.push({ at, ev: { type: r.is_error ? "PostToolUseFailure" : "PostToolUse", base: { sessionId: id, promptId: e.promptId ?? u.promptId ?? null, agentId: null }, tool: { name: u.name, filePath: input.file_path ?? null, edits, originalFile, command: input.command ?? null, error: r.is_error ? textOf(r.content) || String(r.content ?? "") : null } } });
      }
    }
    if (e.type === "assistant" && Array.isArray(c)) for (const b of c) if (b.type === "tool_use") toolUses.set(b.id, { name: b.name, input: b.input, promptId: e.promptId });
  }
  for (const d of decisions.get(hashId(id)) ?? []) {
    const r = d.rec;
    if (r.turn !== "new" || r.kind !== "main") continue;
    events.push({ at: Date.parse(r.at), ev: null, decision: { id: r.id, at: Date.parse(r.at), sessionId: id, agentId: null, kind: r.kind, turn: r.turn, conv: r.conv, requestedModel: r.requested?.model ?? null, sentModel: r.forwarded?.model ?? null } });
  }
  events.sort((a, b) => a.at - b.at);
  for (const x of events) {
    clock = x.at;
    if (x.ev) tracker.ingest(x.ev);
    else tracker.onDecision(x.decision);
  }
  tracker.flush();

  const labels = [...new Set((decisions.get(hashId(id)) ?? []).map((d) => d.label))].join("+");
  const outcomes = out.filter((r) => r.record === "outcome");
  const newMain = (decisions.get(hashId(id)) ?? []).filter((d) => d.rec.turn === "new" && d.rec.kind === "main").length;
  console.log(`\n== ${labels} session ${hashId(id)}: ${prompts} user prompts, ${newMain} logged main new turns, ${outcomes.filter((o) => o.decision_id).length} joined, ${out.filter((r) => r.record === "harness_injected").length} harness_injected`);
  for (const o of outcomes) {
    const c = o.signals.correction;
    const flags = [
      c && c.score > 0 ? `correction ${c.score} [${c.matched.join(",")}]` : null,
      o.signals.test_failure_after_edit.detected ? `test_failure_after_edit ${o.signals.test_failure_after_edit.runs.map((r) => `${r.kind}:${r.exit_code}`).join(",")}` : null,
      o.signals.reverted_edit.detected ? `reverted ${o.signals.reverted_edit.events.map((e) => e.kind).join(",")}` : null,
    ].filter(Boolean);
    console.log(`  turn ${String(o.turn_seq).padStart(2)} ${o.decision_id ? "decided" : "-------"} edits=${o.counts.edits} bash=${o.counts.bash}/${o.counts.bash_failures}fail tests=${o.counts.test_runs}/${o.counts.test_failures}fail ${flags.join(" | ")}`);
  }
  for (const u of out.filter((r) => r.record === "outcome_update")) console.log(`  update: turn ${u.turn_seq} ${u.detail.kind} reverted in turn ${u.detail.detected_in_turn_seq}`);
}
