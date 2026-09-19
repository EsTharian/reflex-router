import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { correctionSignal, coversFile, exitCode, gitRestoredPaths, REVERT_WINDOW_TURNS, testRunnerKind } from "../../src/outcome/heuristics.js";
import { outcomeHooks } from "../../src/outcome/hooks-config.js";
import { parseHookEvent, type HookEvent } from "../../src/outcome/hooks.js";
import { OutcomeTracker, type DecisionInfo, type OutcomeRecord, type OutcomeUpdate, type TrackerRecord } from "../../src/outcome/tracker.js";
import { hashId } from "../../src/log/decision-log.js";

const FIX = "test/fixtures/claude-code/2.1.277";
const events = (file: string): HookEvent[] =>
  fs.readFileSync(`${FIX}/${file}`, "utf8").trim().split("\n").map((l) => parseHookEvent(Buffer.from(l))).filter((e): e is HookEvent => e !== null);

describe("heuristics: correction strength", () => {
  const positive: [string, string][] = [
    ["no, that's wrong", "en:starts_no"],
    ["That's not what I asked for. Use the other file.", "en:thats_wrong"],
    ["please revert that change", "en:undo"],
    ["the tests are still failing", "en:still_failing"],
    ["you broke the build", "en:you_broke"],
    ["it doesn't work", "en:doesnt_work"],
    ["hayır, öyle değil", "tr:starts_no"],
    ["bu yanlış oldu", "tr:wrong"],
    ["olmadı, geri al", "tr:undo"],
    ["bunu istemedim", "tr:not_what_i_said"],
  ];
  for (const [text, rule] of positive) {
    it(`"${text}" matches ${rule}`, () => {
      const c = correctionSignal(text);
      assert.ok(c.matched.includes(rule), c.matched.join());
      assert.ok(c.score > 0);
    });
  }

  it("a short correction is boosted; a long neutral follow-up scores 0", () => {
    assert.equal(correctionSignal("no").score, 1.25);
    const neutral = ["now add tests for the parser", "great, thanks! next: the README", "Nobody uses that API anymore, remove it", "notify me when it's done", "the 'no-network' guard should stay", "şimdi README'yi güncelle", "hallettin mi? teşekkürler"];
    for (const t of neutral) assert.deepEqual(correctionSignal(t).matched, [], t);
  });

  it("only the first 300 characters count; the score is capped", () => {
    assert.equal(correctionSignal("x".repeat(400) + " that's wrong").score, 0);
    assert.ok(correctionSignal("no, that's wrong, not what I asked, undo it, you broke it, it doesn't work, try again").score <= 3);
  });
});

describe("heuristics: commands", () => {
  it("recognises test/build runners and returns a short kind", () => {
    const cases: [string, string | null][] = [
      ["npm test", "npm-test"], ["npm run typecheck", "npm-test"], ["pnpm t", "npm-test"], ["node scripts/run-tests.mjs unit/x", "node-test"],
      ["npx vitest run", "vitest"], ["pytest -q tests/", "pytest"], ["python -m pytest", "pytest"], ["go test ./...", "go-test"],
      ["cargo test", "cargo-test"], ["./gradlew test", "jvm-test"], ["npx tsc --noEmit", "tsc"], ["make check", "make-test"],
      ["ls -la", null], ["git status", null], ["npm install", null], ["cat test.txt", null], ["npm run lint", null],
    ];
    for (const [c, k] of cases) assert.equal(testRunnerKind(c), k, c);
  });

  it("parses the exit code from PostToolUseFailure.error", () => {
    assert.equal(exitCode("Exit code 1"), 1);
    assert.equal(exitCode("Exit code 127\nnot found"), 127);
    assert.equal(exitCode("interrupted"), null);
  });

  it("git commands that restore files", () => {
    assert.deepEqual(gitRestoredPaths("git checkout -- src/a.ts"), ["src/a.ts"]);
    assert.deepEqual(gitRestoredPaths("git restore src/a.ts src/b.ts"), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(gitRestoredPaths("git restore --staged src/a.ts"), [], "unstaging does not touch the working tree");
    assert.deepEqual(gitRestoredPaths("git reset --hard HEAD"), ["*"]);
    assert.deepEqual(gitRestoredPaths("git stash"), ["*"]);
    assert.deepEqual(gitRestoredPaths("git checkout ."), ["*"]);
    assert.deepEqual(gitRestoredPaths("git checkout main"), [], "a branch switch");
    assert.deepEqual(gitRestoredPaths("npm test && git checkout -- a.txt"), ["a.txt"]);
    assert.deepEqual(gitRestoredPaths("git reset --soft HEAD~1"), []);
    assert.ok(coversFile(["src/a.ts"], "/repo/src/a.ts"));
    assert.ok(coversFile(["*"], "/repo/x"));
    assert.ok(!coversFile(["src/a.ts"], "/repo/src/b.ts"));
  });
});

describe("hook payloads (2.1.277 fixtures)", () => {
  it("parse the captured streams; unknown or malformed events are null", () => {
    const e = events("sonnet-agent-run.hooks.jsonl");
    assert.ok(e.some((x) => x.type === "UserPromptSubmit"));
    const fail = e.find((x) => x.type === "PostToolUseFailure");
    assert.ok(fail && fail.type === "PostToolUseFailure");
    assert.equal(exitCode(fail.tool.error), 1);
    const edit = e.find((x) => x.type === "PostToolUse" && x.tool.name === "Edit");
    assert.ok(edit && edit.type === "PostToolUse" && edit.tool.edits.length === 1 && edit.tool.originalFile !== null);
    assert.equal(parseHookEvent(Buffer.from("{")), null);
    assert.equal(parseHookEvent(Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s" }))), null);
  });

  it("the injected settings register exactly the six events, tool events limited to the observed tools", () => {
    const h = outcomeHooks(4321);
    assert.deepEqual(Object.keys(h).sort(), ["PostToolUse", "PostToolUseFailure", "Stop", "SubagentStart", "SubagentStop", "UserPromptSubmit"]);
    assert.equal(h["PostToolUse"]?.[0]?.matcher, "Edit|Write|MultiEdit|NotebookEdit|Bash");
    assert.deepEqual(h["UserPromptSubmit"]?.[0]?.hooks[0], { type: "http", url: "http://127.0.0.1:4321/__reflex/hook", timeout: 2 });
  });
});

// ---- tracker ------------------------------------------------------------------------------------------------------

function tracker(): { t: OutcomeTracker; out: TrackerRecord[]; tick: (ms: number) => void; now: () => number } {
  const out: TrackerRecord[] = [];
  let clock = 1_000_000;
  let n = 0;
  const t = new OutcomeTracker({ emit: (r) => out.push(r), now: () => clock, newId: () => `id-${++n}` });
  return { t, out, tick: (ms) => (clock += ms), now: () => clock };
}
const S = "session-1";
const base = (promptId: string, agentId: string | null = null): { sessionId: string; promptId: string; agentId: string | null } => ({ sessionId: S, promptId, agentId });
const prompt = (id: string, text: string): HookEvent => ({ type: "UserPromptSubmit", base: base(id), prompt: text });
const edit = (id: string, file: string, oldText: string, newText: string, originalFile: string | null = null, agent: string | null = null): HookEvent => ({
  type: "PostToolUse", base: base(id, agent), tool: { name: "Edit", filePath: file, edits: [{ oldText, newText }], originalFile, command: null, error: null },
});
const write = (id: string, file: string, content: string): HookEvent => ({ type: "PostToolUse", base: base(id), tool: { name: "Write", filePath: file, edits: [{ oldText: null, newText: content }], originalFile: null, command: null, error: null } });
const bash = (id: string, command: string, fail: string | null = null, agent: string | null = null): HookEvent => ({
  type: fail ? "PostToolUseFailure" : "PostToolUse", base: base(id, agent), tool: { name: "Bash", filePath: null, edits: [], originalFile: null, command, error: fail },
});
const outcomes = (out: TrackerRecord[]): OutcomeRecord[] => out.filter((r): r is OutcomeRecord => r.record === "outcome");
const decision = (over: Partial<DecisionInfo>): DecisionInfo => ({ id: "d", at: 0, sessionId: S, agentId: null, kind: "main", turn: "new", conv: "c", requestedModel: "claude-opus-5", sentModel: "claude-sonnet-5", ...over });

describe("OutcomeTracker", () => {
  it("the acceptance sequence: edit, failing test, correction, revert, each joined to the right turn", () => {
    const { t, out, tick, now } = tracker();
    t.ingest(prompt("P1", "make the parser accept empty input"));
    t.onDecision(decision({ id: "D1", at: now() + 50 }));
    tick(1000);
    t.ingest(edit("P1", "/repo/src/parser.ts", "if (s) {", "if (s !== undefined) {"));
    t.ingest(bash("P1", "npm test", "Exit code 1\n3 failing"));
    tick(1000);
    t.ingest(prompt("P2", "no, that's wrong. revert it"));
    t.onDecision(decision({ id: "D2", at: now() + 50 }));
    t.ingest(edit("P2", "/repo/src/parser.ts", "if (s !== undefined) {", "if (s) {"));
    t.ingest(prompt("P3", "thanks"));
    t.flush();

    const [o1, o2, o3] = outcomes(out);
    assert.ok(o1 && o2 && o3);
    assert.equal(o1.decision_id, "D1");
    assert.equal(o1.turn_id, hashId("P1"));
    assert.deepEqual(o1.signals.test_failure_after_edit, { detected: true, runs: [{ kind: "npm-test", exit_code: 1, edits_before: 1 }] });
    assert.ok((o1.signals.correction?.score ?? 0) >= 1, "P2 reads as a correction of P1's reply");
    assert.ok(o1.signals.correction?.matched.includes("en:thats_wrong"));
    assert.equal(o1.window.closed_by, "next_prompt");
    // The revert happened in turn 2, after turn 1 had closed: it arrives as an update keyed to D1.
    const u = out.find((r): r is OutcomeUpdate => r.record === "outcome_update");
    assert.ok(u);
    assert.equal(u.decision_id, "D1");
    assert.deepEqual(u.detail, { kind: "inverse_edit", file: hashId("/repo/src/parser.ts"), offset_turns: 1, detected_in_turn_seq: 2 });
    assert.equal(o2.decision_id, "D2");
    assert.equal(o2.signals.correction?.score, 0, "'thanks' is not a correction");
    assert.equal(o3.window.closed_by, "session_end");
    assert.equal(o3.signals.correction, null);
    assert.doesNotMatch(JSON.stringify(out), /parser\.ts|make the parser|revert it|if \(s/, "no paths, prompts or code in the records");
  });

  it("same-turn reverts land in the turn's own record: Write restoring the original, git checkout", () => {
    const { t, out } = tracker();
    t.ingest(prompt("P1", "try something"));
    t.ingest(edit("P1", "/r/a.ts", "x", "y", "ORIGINAL A"));
    t.ingest(write("P1", "/r/a.ts", "ORIGINAL A"));
    t.ingest(edit("P1", "/r/b.ts", "1", "2"));
    t.ingest(bash("P1", "git checkout -- b.ts"));
    t.flush();
    const [o] = outcomes(out);
    assert.deepEqual(o?.signals.reverted_edit.events.map((e) => e.kind), ["write_restore", "git_restore"]);
    assert.ok(o?.signals.reverted_edit.detected);
  });

  it("a test failure without an earlier edit, and a passing test, are not test_failure_after_edit", () => {
    const { t, out } = tracker();
    t.ingest(prompt("P1", "run the tests"));
    t.ingest(bash("P1", "npm test", "Exit code 1"));
    t.ingest(bash("P1", "ls", "Exit code 2"));
    t.ingest(edit("P1", "/r/a.ts", "a", "b"));
    t.ingest(bash("P1", "npm test"));
    t.flush();
    const [o] = outcomes(out);
    assert.equal(o?.signals.test_failure_after_edit.detected, false);
    assert.deepEqual(o?.counts, { edits: 1, bash: 3, bash_failures: 2, test_runs: 2, test_failures: 1 });
  });

  it("a revert beyond the window is not attributed", () => {
    const { t, out } = tracker();
    t.ingest(prompt("P0", "a"));
    t.ingest(edit("P0", "/r/a.ts", "a", "b"));
    for (let i = 1; i <= REVERT_WINDOW_TURNS + 1; i++) t.ingest(prompt(`P${i}`, "next"));
    t.ingest(edit(`P${REVERT_WINDOW_TURNS + 1}`, "/r/a.ts", "b", "a"));
    t.flush();
    assert.equal(out.filter((r) => r.record === "outcome_update").length, 0);
  });

  it("subagents: several open at once, each keyed by agent id; its failing test counts in its own window and in the turn", () => {
    const { t, out } = tracker();
    t.ingest(prompt("P1", "do two things"));
    t.ingest({ type: "SubagentStart", base: base("P1", "A1"), agentType: "general-purpose" });
    t.ingest({ type: "SubagentStart", base: base("P1", "A2"), agentType: "Explore" });
    t.onDecision(decision({ id: "DA1", kind: "subagent", agentId: "A1" }));
    t.ingest(edit("P1", "/r/x.ts", "1", "2", null, "A1"));
    t.ingest(bash("P1", "npm test", "Exit code 1", "A1"));
    t.ingest(bash("P1", "ls", null, "A2"));
    t.ingest({ type: "SubagentStop", base: base("P1", "A2") });
    t.ingest({ type: "SubagentStop", base: base("P1", "A1") });
    t.ingest({ type: "SubagentStop", base: base("P1", "NEVER-STARTED") });
    t.ingest(bash("P1", "npm test", "Exit code 1"));
    t.flush();
    const os = outcomes(out);
    const a1 = os.find((o) => o.agent === hashId("A1"));
    const a2 = os.find((o) => o.agent === hashId("A2"));
    assert.equal(os.length, 3, "two subagents + the turn; the unknown SubagentStop is ignored");
    assert.equal(a1?.decision_id, "DA1");
    assert.equal(a1?.agent_type, "general-purpose");
    assert.equal(a1?.signals.test_failure_after_edit.detected, true);
    assert.equal(a2?.counts.bash, 1);
    const main = os.find((o) => o.scope === "main");
    assert.equal(main?.signals.test_failure_after_edit.detected, true, "the turn contained its subagent's edit");
  });

  it("a subagent decision that arrives before SubagentStart is bound when the start arrives", () => {
    const { t, out } = tracker();
    t.ingest(prompt("P1", "x"));
    t.onDecision(decision({ id: "DA", kind: "subagent", agentId: "A9" }));
    t.ingest({ type: "SubagentStart", base: base("P1", "A9"), agentType: null });
    t.ingest({ type: "SubagentStop", base: base("P1", "A9") });
    assert.equal(outcomes(out)[0]?.decision_id, "DA");
  });

  it("a wire new main turn with no UserPromptSubmit is flagged harness_injected; one prompt binds only one turn", () => {
    const { t, out, now } = tracker();
    t.ingest(prompt("P1", "real prompt"));
    t.onDecision(decision({ id: "D1", at: now() }));
    t.onDecision(decision({ id: "D-injected", at: now() + 5000 }));
    t.onDecision(decision({ id: "D-side", at: now(), turn: "side" }));
    const flagged = out.filter((r) => r.record === "harness_injected");
    assert.deepEqual(flagged.map((r) => r.record === "harness_injected" && r.decision_id), ["D-injected"]);
  });

  it("no harness_injected flag in a session where no UserPromptSubmit ever arrived (hooks not delivered)", () => {
    const { t, out, now } = tracker();
    t.onDecision(decision({ id: "D1", at: now() }));
    t.onDecision(decision({ id: "D2", at: now() + 60_000 }));
    assert.equal(out.length, 0);
  });

  it("a window without a wire new turn says why: no_wire_turn and the nearest main-chat wire classification (session 2, seq 5/6)", () => {
    const { t, out, tick, now } = tracker();
    t.ingest(prompt("P4", "real prompt"));
    t.onDecision(decision({ id: "D4", at: now() }));
    tick(10_000);
    // UserPromptSubmit fires for a message from another session; the wire saw it as side/cross_session.
    t.ingest(prompt("P5", "Another Claude session sent a message: ..."));
    t.onDecision(decision({ id: "W1", at: now() + 100, turn: "side", sideKind: "cross_session" }));
    t.onDecision(decision({ id: "W2", at: now() + 4000, turn: "continuation" }));
    tick(12_000);
    t.ingest(prompt("P6", "<task-notification>..."));
    t.onDecision(decision({ id: "W3", at: now() - 300, turn: "side", sideKind: "notification" }));
    tick(3_000);
    t.ingest(prompt("P7", "next real prompt"));
    const os = outcomes(out);
    assert.equal(os[0]?.decision_id, "D4");
    assert.equal(os[0]?.no_decision, null, "a decided window needs no reason");
    assert.deepEqual(os[1]?.no_decision, { reason: "no_wire_turn", nearest_wire: "side:cross_session" });
    assert.deepEqual(os[2]?.no_decision, { reason: "no_wire_turn", nearest_wire: "side:notification" }, "a request just before the hook still counts");
    assert.equal(out.filter((r) => r.record === "harness_injected").length, 0);
  });

  it("no wire request at all in the window: nearest_wire is null", () => {
    const { t, out, tick } = tracker();
    t.ingest(prompt("P1", "a"));
    tick(1000);
    t.ingest(prompt("P2", "b"));
    assert.deepEqual(outcomes(out)[0]?.no_decision, { reason: "no_wire_turn", nearest_wire: null });
  });

  it("a slash-command prompt opens no window and leaves the current turn open; its expansion is not flagged injected", () => {
    const { t, out, tick, now } = tracker();
    t.ingest(prompt("P1", "fix the bug"));
    t.onDecision(decision({ id: "D1", at: now() }));
    tick(5000);
    t.ingest(prompt("P2", "/model sonnet"));
    t.ingest(prompt("P3", "  /review-pr 12"));
    t.onDecision(decision({ id: "D-slash", at: now() + 500 })); // a custom command that expands into a model turn
    assert.equal(outcomes(out).length, 0, "P1 is still open: the slash commands closed nothing");
    assert.equal(out.filter((r) => r.record === "harness_injected").length, 0);
    tick(5000);
    t.ingest(prompt("P4", "no, that's wrong"));
    const [o] = outcomes(out);
    assert.equal(o?.decision_id, "D1");
    assert.ok((o?.signals.correction?.score ?? 0) >= 1, "the correction comes from the next real prompt, not the slash command");
    assert.equal(outcomes(out).length, 1, "no windows for the slash commands");
  });

  it("replays the captured sdk-cli hook stream: subagent window, then the main turn", () => {
    const { t, out } = tracker();
    for (const e of events("sonnet-agent-run.hooks.jsonl")) t.ingest(e);
    t.flush();
    const os = outcomes(out);
    assert.deepEqual(os.map((o) => o.scope), ["subagent", "main"]);
    const main = os[1]!;
    assert.deepEqual(main.counts, { edits: 1, bash: 2, bash_failures: 1, test_runs: 0, test_failures: 0 });
    assert.equal(main.signals.test_failure_after_edit.detected, false, "`node -e process.exit(1)` is not a test run");
  });

  it("replays the captured interactive hook stream: SubagentStop for never-started agents is ignored", () => {
    const { t, out } = tracker();
    for (const e of events("interactive.hooks.jsonl")) t.ingest(e);
    t.flush();
    const subs = outcomes(out).filter((o) => o.scope === "subagent");
    assert.equal(subs.length, 1, "only the Explore agent had a SubagentStart");
    assert.equal(subs[0]?.agent_type, "Explore");
  });

  it("never throws on odd sequences", () => {
    const { t } = tracker();
    t.ingest({ type: "SubagentStop", base: base("X", "nobody") });
    t.ingest(edit("unknown-prompt", "/r/a", "a", "b"));
    t.onDecision(decision({ sessionId: null }));
    t.flush();
    t.flush();
  });
});
