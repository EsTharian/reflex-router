// Phase 2b escalation: the tier arithmetic, the decay, the tracker's signal channel, and the undo re-attribution.
// Everything here is offline and deterministic (the tracker takes an injected clock and id source).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_ESCALATE_THRESHOLD, DEFAULT_ESCALATE_WINDOW_TURNS, loadConfig, type Tier } from "../../src/config.js";
import { decay, escalatedTier, raise, type EscalationEvent } from "../../src/worker/escalation.js";
import { OutcomeTracker, type DecisionInfo, type OutcomeUpdate, type TrackerRecord } from "../../src/outcome/tracker.js";
import type { HookEvent } from "../../src/outcome/hooks.js";

const ALL = { tiers: ["haiku", "sonnet", "opus"] as readonly Tier[], allowFable: false };

describe("escalatedTier: one tier up, never above the requested tier", () => {
  it("moves the pick up exactly one enabled tier", () => {
    assert.equal(escalatedTier("haiku", "opus", ALL, null), "sonnet");
    assert.equal(escalatedTier("sonnet", "opus", ALL, null), "opus");
  });
  it("never goes above the requested tier: at or over it there is nowhere to escalate to", () => {
    assert.equal(escalatedTier("opus", "opus", ALL, null), null);
    assert.equal(escalatedTier("sonnet", "sonnet", ALL, null), null);
    // One up from haiku is sonnet, which is already the ceiling here: it is allowed, but no further.
    assert.equal(escalatedTier("haiku", "sonnet", ALL, null), "sonnet");
  });
  it("skips a disabled tier rather than routing to one that is off", () => {
    const noSonnet = { tiers: ["haiku", "opus"] as readonly Tier[], allowFable: false };
    assert.equal(escalatedTier("haiku", "opus", noSonnet, null), "opus");
  });
  it("respects the context ceiling: a tier that cannot hold the request is skipped", () => {
    // haiku's ceiling is 150k; sonnet has none, so a huge context still escalates haiku -> sonnet.
    assert.equal(escalatedTier("haiku", "opus", ALL, 400_000), "sonnet");
  });
  it("is never a downgrade and never a no-op dressed as a move", () => {
    for (const pick of ["haiku", "sonnet", "opus"] as const) {
      const to = escalatedTier(pick, "opus", ALL, null);
      if (to !== null) assert.notEqual(to, pick, `${pick} -> ${to} must be a real move`);
    }
  });
});

describe("escalation lifetime", () => {
  const ev: EscalationEvent = { conv: "c1", signal: "correction", score: 1.25, decisionId: "D1", turnSeq: 3 };
  it("a second signal restarts the count rather than stacking", () => {
    const first = raise(null, ev, 3);
    const after = decay(decay(first)!)!;
    assert.equal(after.remaining, 1);
    assert.equal(raise(after, { ...ev, signal: "test_failure", score: null }, 3).remaining, 3);
  });
  it("decays to null on the last turn it covers", () => {
    let s = raise(null, ev, 1);
    assert.equal(decay(s), null);
    s = raise(null, ev, 2);
    assert.equal(decay(s)?.remaining, 1);
    assert.equal(decay(decay(s)!), null);
  });
});

describe("REFLEX_ESCALATE settings", () => {
  const cfg = (env: Record<string, string>): ReturnType<typeof loadConfig> => loadConfig({ TYPESAFE_API_KEY: "apikey_x", ...env });
  it("is off by default, with the plan's starting values", () => {
    const r = cfg({});
    assert.ok(r.ok);
    assert.equal(r.config.escalate, false);
    assert.equal(r.config.escalateThreshold, DEFAULT_ESCALATE_THRESHOLD);
    assert.equal(r.config.escalateWindowTurns, DEFAULT_ESCALATE_WINDOW_TURNS);
  });
  it("reads the three settings and refuses values outside their bounds", () => {
    const r = cfg({ REFLEX_ESCALATE: "1", REFLEX_ESCALATE_THRESHOLD: "0.5", REFLEX_ESCALATE_WINDOW_TURNS: "2", REFLEX_MODE: "route" });
    assert.ok(r.ok);
    assert.equal(r.config.escalate, true);
    assert.equal(r.config.escalateThreshold, 0.5);
    assert.equal(r.config.escalateWindowTurns, 2);
    assert.equal(cfg({ REFLEX_ESCALATE_THRESHOLD: "9" }).ok, false, "above CORRECTION_SCORE_CAP");
    assert.equal(cfg({ REFLEX_ESCALATE_WINDOW_TURNS: "0" }).ok, false);
  });
  it("warns when it can have no effect", () => {
    const r = cfg({ REFLEX_ESCALATE: "1", REFLEX_MODE: "shadow" });
    assert.ok(r.ok);
    assert.ok(r.warnings.some((w) => w.includes("REFLEX_ESCALATE")), r.warnings.join("; "));
  });
});

// ---- the tracker's signal channel and the undo re-attribution ---------------------------------------------------

function tracker(): { t: OutcomeTracker; out: TrackerRecord[]; signals: EscalationEvent[]; tick: (ms: number) => void; now: () => number } {
  const out: TrackerRecord[] = [];
  const signals: EscalationEvent[] = [];
  let clock = 1_000_000;
  let n = 0;
  const t = new OutcomeTracker({ emit: (r) => out.push(r), onSignal: (e) => signals.push(e), now: () => clock, newId: () => `id-${++n}` });
  return { t, out, signals, tick: (ms) => (clock += ms), now: () => clock };
}
const base = (promptId: string | null): HookEvent["base"] => ({ sessionId: "S", promptId, agentId: null });
const prompt = (id: string, text: string): HookEvent => ({ type: "UserPromptSubmit", base: base(id), prompt: text });
const edit = (id: string, file: string, oldText: string, newText: string): HookEvent =>
  ({ type: "PostToolUse", base: base(id), tool: { name: "Edit", filePath: file, edits: [{ oldText, newText }], command: null, error: null, originalFile: null } });
const bash = (id: string, command: string, error: string | null = null): HookEvent =>
  ({ type: error === null ? "PostToolUse" : "PostToolUseFailure", base: base(id), tool: { name: "Bash", filePath: null, edits: [], command, error, originalFile: null } });
const decision = (over: Partial<DecisionInfo>): DecisionInfo =>
  ({ id: "D", at: 1_000_050, sessionId: "S", agentId: null, kind: "main", turn: "new", conv: "C", requestedModel: "claude-opus-5", sentModel: "claude-sonnet-5", ...over });

describe("tracker -> router escalation signal", () => {
  it("a routed window closing with a correction hands over one signal, with the score", () => {
    const { t, signals, tick } = tracker();
    t.ingest(prompt("P1", "make it work"));
    t.onDecision(decision({ id: "D1" }));
    tick(1000);
    t.ingest(prompt("P2", "no, that's wrong"));
    assert.deepEqual(signals.map((s) => [s.conv, s.signal, s.decisionId]), [["C", "correction", "D1"]]);
    assert.ok((signals[0]!.score ?? 0) >= 1);
  });

  it("an UNROUTED window hands over nothing: there is no cheaper tier it ran on to escalate away from", () => {
    const { t, signals, tick } = tracker();
    t.ingest(prompt("P1", "make it work"));
    t.onDecision(decision({ id: "D1", sentModel: "claude-opus-5" })); // sent == requested
    tick(1000);
    t.ingest(prompt("P2", "no, that's wrong"));
    assert.deepEqual(signals, []);
  });

  it("one signal per window, correction first, then test failure, then revert", () => {
    const { t, signals, tick } = tracker();
    t.ingest(prompt("P1", "edit and test it"));
    t.onDecision(decision({ id: "D1" }));
    t.ingest(edit("P1", "/r/a.ts", "x", "y"));
    t.ingest(bash("P1", "npm test", "Exit code 1"));
    tick(1000);
    t.ingest(prompt("P2", "thanks")); // no correction, so the test failure is the signal
    assert.deepEqual(signals.map((s) => s.signal), ["test_failure"]);
  });

  it("a window with no signal at all hands over nothing", () => {
    const { t, signals, tick } = tracker();
    t.ingest(prompt("P1", "add a comment"));
    t.onDecision(decision({ id: "D1" }));
    tick(1000);
    t.ingest(prompt("P2", "now the next thing"));
    assert.deepEqual(signals, []);
  });

  it("a consumer that throws never disturbs the records", () => {
    const out: TrackerRecord[] = [];
    const t = new OutcomeTracker({ emit: (r) => out.push(r), onSignal: () => { throw new Error("boom"); }, now: () => 1, newId: () => "x" });
    t.ingest(prompt("P1", "do it"));
    t.onDecision(decision({ id: "D1", at: 1 }));
    t.ingest(prompt("P2", "no, that's wrong"));
    assert.equal(out.filter((r) => r.record === "outcome").length, 1);
  });
});

describe("undo re-attribution (the acceptance bug)", () => {
  it("an undo-family match is re-attributed to the turn the revert undid, not the one before the prompt", () => {
    const { t, out, tick } = tracker();
    t.ingest(prompt("P1", "change the parser"));
    t.onDecision(decision({ id: "D1" }));
    t.ingest(edit("P1", "/r/p.ts", "a", "b"));
    tick(1000);
    t.ingest(prompt("P2", "actually, add a test too")); // turn 2 does something unrelated
    t.onDecision(decision({ id: "D2", at: 1_001_050 }));
    tick(1000);
    t.ingest(prompt("P3", "undo that")); // scores en:undo, and closes turn 2
    t.onDecision(decision({ id: "D3", at: 1_002_050 }));
    t.ingest(edit("P3", "/r/p.ts", "b", "a")); // the revert targets TURN 1
    t.flush();

    const re = out.filter((r): r is OutcomeUpdate => r.record === "outcome_update" && r.signal === "correction_reattributed");
    assert.equal(re.length, 1, "exactly one re-attribution");
    assert.equal(re[0]!.decision_id, "D1", "attributed to the reverted turn, not D2");
    assert.equal(re[0]!.turn_seq, 1);
    const detail = re[0]!.detail as { matched: readonly string[]; offset_turns: number; from_turn_seq: number };
    assert.deepEqual([...detail.matched], ["en:undo"]);
    assert.equal(detail.offset_turns, 2, "the revert reached two turns back");
    assert.equal(detail.from_turn_seq, 2, "the score had landed on turn 2");
    assert.doesNotMatch(JSON.stringify(out), /undo that|parser|\/r\/p\.ts/, "no prompt text or paths in the records");
  });

  it("a same-turn revert (offset 0) is not re-attributed: the score already sits on the right turn", () => {
    const { t, out, tick } = tracker();
    t.ingest(prompt("P1", "change it"));
    t.onDecision(decision({ id: "D1" }));
    tick(1000);
    t.ingest(prompt("P2", "undo that"));
    t.onDecision(decision({ id: "D2", at: 1_001_050 }));
    t.ingest(edit("P2", "/r/p.ts", "a", "b"));
    t.ingest(edit("P2", "/r/p.ts", "b", "a")); // undone inside the same turn
    t.flush();
    assert.equal(out.filter((r) => r.record === "outcome_update" && r.signal === "correction_reattributed").length, 0);
  });

  it("a revert whose prompt carries no undo-family rule is not re-attributed", () => {
    const { t, out, tick } = tracker();
    t.ingest(prompt("P1", "change it"));
    t.onDecision(decision({ id: "D1" }));
    t.ingest(edit("P1", "/r/p.ts", "a", "b"));
    tick(1000);
    t.ingest(prompt("P2", "now make the other change"));
    t.onDecision(decision({ id: "D2", at: 1_001_050 }));
    t.ingest(edit("P2", "/r/p.ts", "b", "a"));
    t.flush();
    assert.equal(out.filter((r) => r.record === "outcome_update" && r.signal === "correction_reattributed").length, 0);
  });
});
