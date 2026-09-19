import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { percentile } from "../../src/report/format.js";
import { buildReport, reportCommand } from "../../src/report/index.js";
import { parseDuration, parseRecords } from "../../src/report/records.js";
import { classifyMoves, costOf, hintArms, MIN_OUTCOME_N, outcomeGroups, s0Workflow, s8Cost, s12SideRouting, harnessFeatureCost, SECTIONS, sideRoutingEstimate, workProfile, wouldRoute, type Ctx } from "../../src/report/sections.js";
import { at, dec, large, mixed, outcome, sideCallLog, singleTurnLongLoop, toJsonl, update, type Rec } from "../support/report-fixtures.js";

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

describe("report: optional harness features", () => {
  it("splits the two features sharing the notification side kind, by marker", () => {
    const lines = harnessFeatureCost(parse(sideCallLog()).decisions, true).join("\n");
    // The synthetic log has one session_recap and one task_notification, both side_kind `notification`.
    assert.match(lines, /Session recap\s+1\s/, lines);
    assert.doesNotMatch(lines, /upper bound/, "the row is exact now, not an upper bound");
    assert.match(lines, /awaySummaryEnabled/);
    assert.match(lines, /promptSuggestionEnabled/);
  });

  it("says what each cost, and without --usd points at the flag rather than silently omitting it", () => {
    const withUsd = harnessFeatureCost(parse(sideCallLog()).decisions, true).join("\n");
    assert.match(withUsd, /\$ at requested model/);
    const without = harnessFeatureCost(parse(sideCallLog()).decisions, false).join("\n");
    assert.doesNotMatch(without, /\$ at requested model/);
    assert.match(without, /rerun with --usd/, "the block promises a cost, so it must say how to see it");
  });

  it("counts side calls that predate the marker separately instead of attributing them", () => {
    const old = toJsonl([
      dec({ id: "o1", t: 0, conv: "o", turn: "new" }),
      { ...dec({ id: "o2", t: 10, conv: "o", turn: "side", side: "notification" }), side_marker: null },
    ]);
    const lines = harnessFeatureCost(parse(old).decisions, true).join("\n");
    assert.match(lines, /1 side call\(s\) of these kinds carry no marker id/, lines);
  });
});

describe("report: side-call routing estimate", () => {
  const archiveDir = path.join(GOLDEN_DIR, "archives");
  it("golden: a synthetic log with warm clusters, a cold gap and an exposed conversation", () => {
    golden("side-routing-synthetic", s12SideRouting(ctxOf(sideCallLog(), true)).join("\n") + "\n");
  });
  it("golden: the archived real sessions", () => {
    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl")).sort();
    const rec = parseRecords(files.map((f) => ({ source: f, text: fs.readFileSync(path.join(archiveDir, f), "utf8") })));
    golden("side-routing-archives", s12SideRouting({ rec, byId: new Map(), usd: true }).join("\n") + "\n");
  });

  it("only go-list kinds count; cross_session and the rest are never estimated", () => {
    const e = sideRoutingEstimate(parse(sideCallLog()).decisions, { tier: "haiku" });
    assert.deepEqual(e.perKind.map((k) => k.kind).sort(), ["no_tools", "notification", "suggestion"]);
    assert.equal(e.calls, 6, "the cross_session call and both non-side turns are excluded");
  });

  it("warm follows the TTL: calls inside it reuse the prefix, one past it pays a full write again", () => {
    const e = sideRoutingEstimate(parse(sideCallLog()).decisions, { tier: "haiku" });
    // a-s1 cold (first), a-s2/a-s3/a-n1 warm, a-n2 cold (40 min later), a-t1 warm (10 s after a-n2)
    assert.equal(e.cold, 2);
    assert.equal(e.warm, 4);
  });

  it("a cold call is priced as a full write of the whole prompt, so it costs more than leaving it alone", () => {
    // One lone side call in its own conversation can never be warm: the estimate must not show it as a saving.
    const lone = toJsonl([dec({ id: "c-new", t: 0, conv: "c", turn: "new" }), dec({ id: "c-s", t: 10, conv: "c", turn: "side", side: "notification", usage: [2, 50, 100_000, 500] })]);
    const e = sideRoutingEstimate(parse(lone).decisions, { tier: "haiku" });
    assert.equal(e.warm, 0);
    assert.equal(e.cold, 1);
    assert.ok(e.usdAtSide > e.usdAtRequested, `a cold swap must cost more: at side ${e.usdAtSide}, at requested ${e.usdAtRequested}`);
  });

  it("exposure lists only conversations routed below requested or moving up, with each up-move's cache write", () => {
    const e = sideRoutingEstimate(parse(sideCallLog()).decisions, { tier: "haiku" });
    const b = e.convs.find((c) => c.conv === "conv-exposed-b");
    assert.ok(b, "the routed conversation is listed");
    assert.equal(b.pinnedBelow, true);
    assert.equal(b.upMoves, 1);
    assert.deepEqual(b.upMoveCacheWrites, [47_000]);
    assert.ok(!e.convs.some((c) => c.conv === "conv-side-a"), "a conversation that never moved tier is not exposed");
  });

  it("a call larger than the side tier's context ceiling is not routable and never counts as a saving", () => {
    // The biggest side calls in real logs are hundreds of thousands of tokens; haiku cannot hold them at all.
    const big = toJsonl([
      dec({ id: "d-new", t: 0, conv: "d", turn: "new" }),
      dec({ id: "d-s", t: 10, conv: "d", turn: "side", side: "notification", usage: [2, 50, 400_000, 500] }),
    ]);
    const e = sideRoutingEstimate(parse(big).decisions, { tier: "haiku" });
    assert.equal(e.calls, 0, "nothing is routable");
    assert.equal(e.overCeiling, 1);
    assert.equal(e.usdAtRequested - e.usdAtSide, 0, "an unroutable call contributes no saving either way");
    assert.equal(e.perKind.find((k) => k.kind === "notification")?.overCeiling, 1);
  });

  it("the target tier's ceiling decides what is routable: sonnet has none, haiku cannot hold a big call", () => {
    const big = toJsonl([
      dec({ id: "e-new", t: 0, conv: "e", turn: "new" }),
      dec({ id: "e-s", t: 10, conv: "e", turn: "side", side: "notification", usage: [2, 50, 400_000, 500] }),
    ]);
    const decs = parse(big).decisions;
    assert.equal(sideRoutingEstimate(decs, { tier: "haiku" }).calls, 0);
    assert.equal(sideRoutingEstimate(decs, { tier: "sonnet" }).calls, 1, "sonnet has no context ceiling");
  });

  it("the carve-out drops conversations ever pinned below the requested tier", () => {
    const decs = parse(sideCallLog()).decisions;
    const all = sideRoutingEstimate(decs, { tier: "sonnet" });
    const carved = sideRoutingEstimate(decs, { tier: "sonnet", excludePinnedBelow: true });
    assert.ok(all.calls > 0);
    assert.equal(carved.calls, all.calls, "conv-exposed-b has no side calls, so the carve-out removes none here");
    // A side call inside the routed conversation IS removed by the carve-out.
    const withSide = toJsonl([
      dec({ id: "f-new", t: 0, conv: "f", turn: "new", sent: "haiku", rewritten: true, usage: [10, 200, 0, 40_000] }),
      dec({ id: "f-s", t: 60, conv: "f", turn: "side", side: "notification", usage: [2, 50, 40_000, 400] }),
    ]);
    const d2 = parse(withSide).decisions;
    assert.equal(sideRoutingEstimate(d2, { tier: "sonnet" }).calls, 1);
    assert.equal(sideRoutingEstimate(d2, { tier: "sonnet", excludePinnedBelow: true }).calls, 0, "the routed conversation's side call is carved out");
  });

  it("forcing a TTL prices both sides at it and stops claiming it was assumed", () => {
    const decs = parse(sideCallLog()).decisions;
    const short = sideRoutingEstimate(decs, { tier: "sonnet", ttl: "5m" });
    const long = sideRoutingEstimate(decs, { tier: "sonnet", ttl: "1h" });
    assert.equal(short.ttlAssumed, false);
    assert.ok(long.warm >= short.warm, "a longer TTL can only keep more calls warm");
  });

  it("the TTL is flagged as assumed when no record logged the beta", () => {
    assert.equal(sideRoutingEstimate(parse(sideCallLog()).decisions, { tier: "haiku" }).ttlAssumed, true);
    const withBeta = toJsonl([{ ...dec({ id: "z", t: 0, conv: "z", turn: "side", side: "notification" }), cache_ttl_beta: true }]);
    assert.equal(sideRoutingEstimate(parse(withBeta).decisions, { tier: "haiku" }).ttlAssumed, false);
  });
});

describe("report: workflow profile", () => {
  const archiveDir = path.join(GOLDEN_DIR, "archives");
  it("golden: the archived real sessions (structural copies, scripts/report/strip-archive.mjs)", () => {
    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl")).sort();
    assert.ok(files.length >= 6, "the six archived logs are present");
    const rec = parseRecords(files.map((f) => ({ source: f, text: fs.readFileSync(path.join(archiveDir, f), "utf8") })));
    golden("workflow-archives", s0Workflow({ rec, byId: new Map(), usd: false }).join("\n") + "\n");
  });
  it("golden: a single-turn, long-loop log shaped like the first real-work dogfood", () => {
    golden("workflow-single-turn-long-loop", s0Workflow(ctxOf(singleTurnLongLoop())).join("\n") + "\n");
  });
  it("single-turn long loops judged opus: nothing is touchable, continuations carry the tokens", () => {
    const p = workProfile(parse(singleTurnLongLoop()).decisions);
    assert.deepEqual(p.requests, { new: 2, continuation: 43, subagent: 0, side: 5 });
    assert.equal(p.tokens.side, 2 * 226_310 + 3 * 40_053);
    assert.equal(p.touchable, 0);
    assert.equal(p.units, 2);
    const out = s0Workflow(ctxOf(singleTurnLongLoop())).join("\n");
    assert.match(out, /routing can touch at most 0\.0% of your tokens; - of that is in subagents/);
  });
  it("a turn planned below the requested tier makes its whole loop touchable; subagent share is of the touchable part", () => {
    const S = "eeeeeeeeeeeeeeee";
    const M = `${S}:m:0000000000000001`;
    const A = `${S}:a:0000000000000002`;
    const text = toJsonl([
      dec({ id: "m1", t: 0, session: S, conv: M, probs: [0, 0, 1], pickMass: "opus", planTier: null, usage: [0, 0, 0, 100] }),
      dec({ id: "m2", t: 1, session: S, conv: M, turn: "continuation", usage: [0, 0, 0, 100] }),
      dec({ id: "a1", t: 2, session: S, conv: A, kind: "subagent", probs: [0, 1, 0], pickMass: "sonnet", planTier: "sonnet", usage: [0, 0, 0, 200] }),
      dec({ id: "a2", t: 3, session: S, conv: A, kind: "subagent", turn: "continuation", usage: [0, 0, 0, 200] }),
      dec({ id: "m3", t: 4, session: S, conv: M, probs: [1, 0, 0], pickMass: "haiku", planTier: "haiku", usage: [0, 0, 0, 50] }),
      dec({ id: "m4", t: 5, session: S, conv: M, turn: "continuation", usage: [0, 0, 0, 50] }),
      dec({ id: "sd", t: 6, session: S, conv: M, turn: "side", side: "suggestion", usage: [0, 0, 0, 300] }),
      dec({ id: "x1", t: 7, session: S, conv: "orphan", turn: "continuation", usage: [0, 0, 0, 0] }),
      dec({ id: "g1", t: 8, session: S, conv: "guarded", planTier: null, guard: { allowed: false, reason: "over_limit", penalty: 0.1 }, reasons: ["guard_blocked"], usage: [0, 0, 0, 0] }),
    ]);
    const p = workProfile(parse(text).decisions);
    assert.equal(p.total, 1000);
    assert.equal(p.touchable, 500, "the subagent loop (400) and the second main turn with its continuation (100); the first turn and the side call are not");
    assert.equal(p.touchableSubagent, 400);
    assert.equal(p.orphanContinuations, 1);
    assert.equal(p.undecidedNew, 1);
    assert.match(s0Workflow(ctxOf(text)).join("\n"), /routing can touch at most 50\.0% of your tokens; 80\.0% of that is in subagents/);
  });
});

describe("report: delegation hint split", () => {
  // Session H (hint on): two user turns, a subagent carries most tokens. Session N (off): one turn, a long loop.
  const text = (): string => {
    const H = "hhhhhhhhhhhhhhhh";
    const N = "nnnnnnnnnnnnnnnn";
    const hinted = (r: Rec): Rec => ({ ...r, delegate_hint: "delegate-1" });
    return toJsonl([
      hinted(dec({ id: "h1", t: 0, session: H, conv: `${H}:m:1`, probs: [0, 0, 1], pickMass: "opus", planTier: null, usage: [0, 0, 0, 1000] })),
      hinted(dec({ id: "h2", t: 1, session: H, conv: `${H}:a:2`, kind: "subagent", probs: [0, 1, 0], pickMass: "sonnet", planTier: "sonnet", usage: [0, 0, 0, 3000] })),
      hinted(dec({ id: "h3", t: 2, session: H, conv: `${H}:a:2`, kind: "subagent", turn: "continuation", usage: [0, 0, 0, 3000] })),
      hinted(dec({ id: "h4", t: 3, session: H, conv: `${H}:m:1`, probs: [0, 0, 1], pickMass: "opus", planTier: null, usage: [0, 0, 0, 1000] })),
      hinted(dec({ id: "h5", t: 4, session: H, conv: `${H}:m:1`, turn: "side", side: "suggestion", usage: [0, 0, 0, 2000] })),
      { v: 1, record: "delegate_hint", id: "dh1", at: at(0), session: H, version: "delegate-1" },
      { v: 1, record: "delegate_hint", id: "dh2", at: at(3), session: H, version: "delegate-1" },
      dec({ id: "n1", t: 10, session: N, conv: `${N}:m:1`, probs: [0, 0, 1], pickMass: "opus", planTier: null, usage: [0, 0, 0, 1000] }),
      dec({ id: "n2", t: 11, session: N, conv: `${N}:m:1`, turn: "continuation", usage: [0, 0, 0, 4000] }),
    ]);
  };
  it("arms by hint version: sessions, delivered hints, user turns, tokens, subagent and side shares", () => {
    const arms = hintArms(parse(text()));
    assert.deepEqual(arms.map((a) => [a.hint, a.sessions, a.delivered, a.userTurns, a.tokens, a.subagentTokens, a.sideTokens]), [
      ["off", 1, 0, 1, 5000, 0, 0],
      ["delegate-1", 1, 2, 2, 10000, 6000, 2000],
    ]);
    assert.ok(arms.every((a) => a.usdAtSent > 0));
  });
  it("the profile shows tokens and $ per user turn by hint; section 8 compares with and without, marking n", () => {
    const profile = s0Workflow(ctxOf(text())).join("\n");
    assert.match(profile, /delegate-1\s+1\s+2\s+2\s+10,000\s+5,000\s+\$\S+\s+\$\S+\s+60\.0%\s+20\.0%/);
    assert.match(profile, /off\s+1\s+-\s+1\s+5,000\s+5,000/);
    const s8 = s8Cost(ctxOf(text())).join("\n");
    assert.match(s8, /delegation \(all requests incl\. side calls.*too few to compare\): with delegate-1 \(n=1 session, 2 user turns\): subagent share 60\.0%, 5,000 tokens per user turn; without \(n=1 session, 1 user turn\): subagent share 0\.0%, 5,000 tokens per user turn/);
    assert.match(s8Cost(ctxOf(text(), true)).join("\n"), /5,000 tokens and \$\S+ per user turn/);
    assert.match(s8Cost(ctxOf(singleTurnLongLoop())).join("\n"), /delegation: no session ran with the hint/);
  });
  it("delegate_hint records are counted in the header, not as unknown records", () => {
    const out = buildReport(parse(text()), { usd: false });
    assert.match(out, /2 delegate_hint/);
    assert.doesNotMatch(out, /of an unknown type/);
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
