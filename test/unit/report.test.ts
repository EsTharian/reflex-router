import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { percentile } from "../../src/report/format.js";
import { buildReport, reportCommand } from "../../src/report/index.js";
import { parseDuration, parseRecords } from "../../src/report/records.js";
import { classifyMoves, costOf, MIN_OUTCOME_N, outcomeGroups, SECTIONS, wouldRoute, type Ctx } from "../../src/report/sections.js";
import { at, dec, large, mixed, outcome, toJsonl, update, type Rec } from "../support/report-fixtures.js";

const GOLDEN_DIR = path.join("test", "fixtures", "report");
const parse = (text: string) => parseRecords([{ source: "test.jsonl", text }]);
const ctxOf = (text: string, usd = false): Ctx => {
  const rec = parse(text);
  return { rec, byId: new Map(rec.decisions.map((d) => [d.id, d])), usd };
};

/** Compares with test/fixtures/report/<name>.txt; UPDATE_GOLDEN=1 rewrites it (review the diff). */
function golden(name: string, actual: string): void {
  const file = path.join(GOLDEN_DIR, `${name}.txt`);
  if (process.env["UPDATE_GOLDEN"] === "1") {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, actual);
  }
  assert.equal(actual, fs.readFileSync(file, "utf8"), `report differs from ${file} (UPDATE_GOLDEN=1 to accept)`);
}

describe("report: golden files", () => {
  it("empty input: every section is present and says there is nothing", () => {
    const out = buildReport(parse(""), { usd: false });
    for (const s of SECTIONS) assert.ok(out.includes(s.title), s.title);
    golden("empty", out);
  });
  it("a single record", () => {
    golden("single", buildReport(parse(toJsonl([dec({ id: "only", t: 0, probs: [1, 0, 0], pickMass: "haiku", sent: "haiku" })])), { usd: false }));
  });
  it("a mixed shadow + route log (usage headroom)", () => {
    golden("mixed", buildReport(parse(mixed()), { usd: false }));
  });
  it("the same log with --usd", () => {
    golden("mixed-usd", buildReport(parse(mixed()), { usd: true }));
  });
  it("a large log (6000 decisions) renders quickly and matches", () => {
    const text = large(6000);
    const started = Date.now();
    const out = buildReport(parse(text), { usd: true });
    assert.ok(Date.now() - started < 5000, "report over 6000 records takes under 5 s");
    golden("large", out);
  });
});

describe("report: reading", () => {
  it("counts lines that are not records and ignores unknown record types, without failing", () => {
    const r = parse(mixed());
    assert.equal(r.skippedLines, 1);
    assert.equal(r.unterminatedLines, 0);
    assert.equal(r.other, 1);
    assert.equal(r.decisions.length, 8 + 14);
  });
  it("ignores an unterminated last line (a log being written) and counts it as skipped; the next read has it", () => {
    const a = JSON.stringify(dec({ id: "a", t: 0 }));
    const full = JSON.stringify(dec({ id: "b", t: 1, error: "x".repeat(900) }));
    const torn = full.slice(0, 954); // cut mid-string, the shape of the CI failure
    const r = parse(`${a}\n${torn}`);
    assert.deepEqual(r.decisions.map((d) => d.id), ["a"]);
    assert.equal(r.skippedLines, 1);
    assert.equal(r.unterminatedLines, 1);
    assert.match(buildReport(r, { usd: false }), /skipped 1 line\(s\): 0 not valid records, 1 unterminated last line\(s\) \(still being written/);
    const later = parse(`${a}\n${full}\n`);
    assert.deepEqual(later.decisions.map((d) => d.id), ["a", "b"]);
    assert.equal(later.skippedLines, 0);
  });
  it("skips a last line that has no newline even if it happens to parse, and counts it separately per file", () => {
    const line = JSON.stringify(dec({ id: "only", t: 0 }));
    const r = parseRecords([{ source: "live", text: `${JSON.stringify(dec({ id: "a", t: 0 }))}\n${line}` }, { source: "rotated", text: `${JSON.stringify(dec({ id: "c", t: 2 }))}\nnot json\n` }]);
    assert.deepEqual(r.decisions.map((d) => d.id), ["a", "c"]);
    assert.equal(r.unterminatedLines, 1);
    assert.equal(r.skippedLines, 2, "the unterminated line plus one complete line that is not JSON");
    assert.match(buildReport(r, { usd: false }), /skipped 2 line\(s\): 1 not valid records, 1 unterminated last line\(s\)/);
  });
  it("reads records from before M4 (no `record` field, no pick_mass, no connection)", () => {
    const legacy = { v: 1, id: "old", at: at(0), session: "s", conv: "s:m:1", kind: "main", turn: "new", side_kind: null, mode_requested: "shadow", mode_effective: "shadow", requested: { model: "claude-opus-5", tier: "opus" }, forwarded: { model: "claude-opus-5", rewritten: false, fallback: false }, upstream: { status: 200, msToHeaders: 1000 }, usage: { input: 1, output: 2, cache_read: 3, cache_create: 4 }, decision: { picks: { tier: { value: "haiku", confidence: 0.99, probabilities: { haiku: 1 } } }, vetoes: {}, latencyMs: 800, tokensIn: 1, backendModel: "jev" }, plan: { target: { tier: "haiku" }, would_route_to: "claude-haiku-4-5-20251001", routed_to: "claude-opus-5", reasons: ["guard_not_evaluated", "downgrade"], would_upgrade: false } };
    const r = parse(toJsonl([legacy]));
    assert.equal(r.decisions.length, 1);
    assert.equal(r.decisions[0]!.pickMass, null);
    assert.equal(r.decisions[0]!.connection, null);
    assert.equal(r.decisions[0]!.planTier, "haiku");
    assert.match(buildReport(r, { usd: false }), /0 log both readings/);
  });
  it("counts a record once when it appears in a live file and its archived copy", () => {
    const text = toJsonl([dec({ id: "dup", t: 0 })]);
    assert.equal(parseRecords([{ source: "a", text }, { source: "b", text }]).decisions.length, 1);
  });
  it("parseDuration accepts s/m/h/d and nothing else", () => {
    assert.equal(parseDuration("90s"), 90_000);
    assert.equal(parseDuration("2h"), 7_200_000);
    assert.equal(parseDuration("7d"), 604_800_000);
    for (const bad of ["", "2", "h", "2 weeks", "-1h", "1.5h"]) assert.equal(parseDuration(bad), null, bad);
  });
  it("percentile is nearest-rank", () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([5], 95), 5);
    assert.equal(percentile([1, 2, 3, 4], 50), 2);
    assert.equal(percentile([4, 1, 3, 2], 75), 3);
    assert.equal(percentile([1, 2, 3, 4], 95), 4);
  });
});

describe("report: section numbers", () => {
  it("wouldRoute: mass takes its pick; argmax moves down only at confidence >= 0.7; neither goes above the requested tier", () => {
    const d = (o: Partial<Parameters<typeof dec>[0]>) => parse(toJsonl([dec({ id: "x", t: 0, probs: [0, 1, 0], ...o })])).decisions[0]!;
    assert.equal(wouldRoute("mass", d({ pickMass: "sonnet", pickArgmax: "haiku", confidence: 0.3 })), "sonnet");
    assert.equal(wouldRoute("argmax", d({ pickMass: "sonnet", pickArgmax: "haiku", confidence: 0.3 })), "opus");
    assert.equal(wouldRoute("argmax", d({ pickMass: "sonnet", pickArgmax: "haiku", confidence: 0.9 })), "haiku");
    assert.equal(wouldRoute("mass", d({ requested: "sonnet", pickMass: "opus", pickArgmax: "opus" })), "sonnet");
  });

  it("cache moves follow the session B pattern: down writes the whole context, up short of requested writes more than back to requested", () => {
    const S = "cccccccccccccccc:m:1";
    const rows = [
      dec({ id: "1", t: 0, conv: S, sent: "haiku", usage: [1, 1, 0, 63689] }),
      dec({ id: "2", t: 10, conv: S, turn: "continuation", sent: "haiku", usage: [1, 1, 63689, 7557] }),
      dec({ id: "3", t: 20, conv: S, sent: "sonnet", usage: [1, 1, 61130, 13385] }),
      dec({ id: "4", t: 30, conv: S, sent: "opus", usage: [1, 1, 74398, 5924] }),
      dec({ id: "5", t: 40, conv: S, sent: "opus", usage: [1, 1, 74398, 60] }),
      dec({ id: "6", t: 41, conv: S, turn: "side", sent: "opus", usage: [1, 1, 74398, 60] }),
    ];
    const moves = classifyMoves(parse(toJsonl(rows)).decisions);
    assert.deepEqual(moves.map((m) => [m.dec.id, m.move]), [["1", "down"], ["3", "up_one_tier"], ["4", "back_to_requested"], ["5", "stayed"]]);
  });

  it("cost prices the same tokens at the sent and the requested model", () => {
    const d = parse(toJsonl([dec({ id: "1", t: 0, sent: "haiku", usage: [1_000_000, 0, 0, 0] }), dec({ id: "2", t: 1, usage: [1_000_000, 0, 0, 0] })])).decisions;
    const c = costOf(d);
    assert.equal(c.n, 2);
    assert.equal(c.atSentUsd, 1 + 5); // haiku $1/M input + opus $5/M input
    assert.equal(c.atRequestedUsd, 5 + 5);
  });

  it("outcomes are joined to their decision: routed vs unchanged, later reverts counted, no-decision windows say why", () => {
    const text = toJsonl([
      dec({ id: "R", t: 0, sent: "haiku", probs: [1, 0, 0], pickMass: "haiku" }),
      dec({ id: "U", t: 1, probs: [0, 0, 1] }),
      outcome({ id: "o1", t: 5, decision: "R", edits: 1 }),
      outcome({ id: "o2", t: 6, decision: "U", edits: 1, testFailure: true }),
      outcome({ id: "o3", t: 7, decision: null }),
      update("u1", 8, "R"),
    ]);
    const g = outcomeGroups(ctxOf(text));
    const by = (arm: string) => g.find((x) => x.arm === arm)!;
    assert.equal(by("routed").windows.length, 1);
    assert.equal(by("routed").reverted.size, 1);
    assert.equal(by("unchanged").windows[0]!.testFailureAfterEdit, true);
    assert.equal(by("no decision").windows[0]!.noDecisionReason, "no_wire_turn");
  });

  it(`shows no rates below n=${MIN_OUTCOME_N} and says so; shows them at the minimum`, () => {
    const mk = (n: number): string => {
      const rows: Rec[] = [dec({ id: "U", t: 0, probs: [0, 0, 1] })];
      for (let i = 0; i < n; i++) rows.push(outcome({ id: `o${i}`, t: 1 + i, decision: "U", edits: 1, score: 0 }));
      return toJsonl(rows);
    };
    const small = buildReport(parse(mk(MIN_OUTCOME_N - 1)), { usd: false });
    assert.match(small, /insufficient data: n=19 < 20; no rates shown/);
    assert.doesNotMatch(small, /rates: correction/);
    assert.match(buildReport(parse(mk(MIN_OUTCOME_N)), { usd: false }), /rates: correction > 0 in 0\.0% of scored/);
  });

  it("timed-out decisions are checked against deadline + grace: within, exceeded, and unverifiable (no timing block)", () => {
    const rows = (wait: number | null): string =>
      toJsonl([dec({ id: "t", t: 0, error: "backend:timeout", reasons: [], planTier: null, ...(wait === null ? { legacyTiming: true } : { wait }) })]);
    assert.match(buildReport(parse(rows(1500)), { usd: false }), /timed-out decisions in route mode: 1; 1 with timing, longest wait 1,500 ms, deadline 1500 ms \+ 250 ms grace: all within/);
    assert.match(buildReport(parse(rows(1750)), { usd: false }), /all within/, "the bound itself is allowed");
    assert.match(buildReport(parse(rows(1751)), { usd: false }), /1 EXCEEDED it/);
    assert.match(buildReport(parse(rows(null)), { usd: false }), /timed-out decisions in route mode: 1; 0 with timing \(cannot be checked against the deadline/);
  });

  it("the latency section shows the decision wait and the upstream first byte, and counts records that predate them", () => {
    const text = toJsonl([
      dec({ id: "a", t: 0, sent: "haiku", probs: [1, 0, 0], pickMass: "haiku", wait: 400, msToHeaders: 1000 }),
      dec({ id: "b", t: 1, sent: "haiku", probs: [1, 0, 0], pickMass: "haiku", legacyTiming: true, msToHeaders: 2000 }),
    ]);
    const out = buildReport(parse(text), { usd: false });
    assert.match(out, /routed \(after a decision\)\s+2\s+1,000 ms\s+2,000 ms\s+400 ms\s+400 ms\s+600 ms\s+600 ms/);
    assert.match(out, /1 of 2 of these records predate the timing block/);
  });

  it("side calls are never attributed to the routed model", () => {
    const text = toJsonl([dec({ id: "1", t: 0, sent: "haiku", usage: [0, 0, 0, 1000] }), dec({ id: "2", t: 1, turn: "side", usage: [0, 0, 0, 5000] })]);
    const out = buildReport(parse(text), { usd: false });
    assert.match(out, /9\. Side-call usage\n {2}1 side calls[^\n]*\n[^\n]*\n {4}suggestion\s+1\s+5,000/);
    assert.match(out, /side calls sent to a model other than the requested one: 0\n/);
    assert.match(out, /routed only\s+1\s+1,000/); // section 8 holds only the 1000 routed tokens
  });

  it("--since keeps the outcome-to-decision join even when the decision is out of range", () => {
    const rows = [dec({ id: "old", t: 0, sent: "haiku", probs: [1, 0, 0], pickMass: "haiku" }), outcome({ id: "o1", t: 100, decision: "old", edits: 1 })];
    const all = parse(toJsonl(rows));
    const out = buildReport(all, { usd: false, fromMs: Date.parse(at(50)) });
    assert.match(out, /records in range: 0 decisions, 1 outcomes/);
    assert.match(out, /main \/ routed: 1 window/);
  });
});

describe("reflex report (command)", () => {
  const run = (args: string[], env: NodeJS.ProcessEnv, now?: number) => {
    let stdout = "";
    let stderr = "";
    const code = reportCommand(args, { env, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), ...(now !== undefined ? { now: () => now } : {}) });
    return { code, stdout, stderr };
  };
  const home = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "reflex-report-"));

  it("reads decisions.jsonl and its rotations under REFLEX_HOME and prints all ten sections", () => {
    const h = home();
    fs.writeFileSync(path.join(h, "decisions.jsonl"), toJsonl([dec({ id: "a", t: 10 })]));
    fs.writeFileSync(path.join(h, "decisions.jsonl.1"), toJsonl([dec({ id: "b", t: 0 })]));
    const r = run([], { REFLEX_HOME: h });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /records in range: 2 decisions/);
    for (const s of SECTIONS) assert.ok(r.stdout.includes(s.title), s.title);
  });
  it("without a log it still prints every section, and says where it looked", () => {
    const r = run([], { REFLEX_HOME: home() });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /no decision log at/);
    for (const s of SECTIONS) assert.ok(r.stdout.includes(s.title), s.title);
  });
  it("--since filters by time, --usd adds dollar columns", () => {
    const h = home();
    const file = path.join(h, "d.jsonl");
    fs.writeFileSync(file, toJsonl([dec({ id: "old", t: 0, sent: "haiku" }), dec({ id: "new", t: 7000, sent: "haiku" })]));
    const now = Date.parse(at(7200));
    const r = run(["--since", "1h", "--usd", file], {}, now);
    assert.match(r.stdout, /records in range: 1 decisions/);
    assert.match(r.stdout, /\$ at requested/);
    assert.doesNotMatch(run([file], {}).stdout, /\$ at requested/);
  });
  it("rejects a bad --since and an unknown option (exit 2), and an unreadable file (exit 1)", () => {
    assert.equal(run(["--since", "soon"], {}).code, 2);
    assert.equal(run(["--since"], {}).code, 2);
    assert.equal(run(["--nope"], {}).code, 2);
    const r = run([path.join(home(), "missing.jsonl")], {});
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot read/);
  });
  it("makes no network connection and writes nothing (it only reads)", () => {
    const h = home();
    fs.writeFileSync(path.join(h, "decisions.jsonl"), toJsonl([dec({ id: "a", t: 0 })]));
    const before = fs.readdirSync(h);
    run([], { REFLEX_HOME: h });
    assert.deepEqual(fs.readdirSync(h), before);
  });
});
