// The sections of `reflex report`. Each takes the normalised records and returns lines of text; the numbers a section
// computes that are worth testing on their own (moves, cost, outcome join) are exported. Pure, no I/O, no network.
import { TIERS, type Tier } from "../config.js";
import { DOWNGRADE_MIN_CONFIDENCE } from "../policy.js";
import { LAST_VERIFIED, usageCostUsd } from "../pricing.js";
import { DECISION_GRACE_MS } from "../timing.js";
import { tierRank } from "../tiers.js";
import { countBy, int, mean, median, ms, pct, percentile, sum, table, usd } from "./format.js";
import { num, totalTokens, type Dec, type OutcomeRec, type Records } from "./records.js";

/** Below this many outcome windows in a group no rate is shown (docs/observations.md: a handful of turns says little). */
export const MIN_OUTCOME_N = 20;

export interface Ctx {
  /** The records in range. */
  readonly rec: Records;
  /** Every decision in the files, in range or not: outcome records are joined to their decision here. */
  readonly byId: ReadonlyMap<string, Dec>;
  readonly usd: boolean;
}

const NONE = ["  (no records)"];
const tierCols = (used: ReadonlySet<string>): string[] => [...TIERS.filter((t) => used.has(t)), ...(used.has("?") ? ["?"] : [])];
const tl = (t: Tier | null): string => t ?? "?";
const newTurns = (d: readonly Dec[]): Dec[] => d.filter((x) => x.turn === "new");
const tokens = (d: Dec): number => (d.usage ? totalTokens(d.usage) : 0);

/** Where a request's tokens count in the workflow profile. Anything not a positively identified turn or loop step is `side`, as in the classifier. */
export type WorkCategory = "new" | "continuation" | "subagent" | "side";
export const workCategory = (d: Dec): WorkCategory =>
  d.turn !== "new" && d.turn !== "continuation" ? "side" : d.kind === "subagent" ? "subagent" : d.turn;

/** The plan for this new turn put it below the requested tier (shadow: would have; route: before the cost guard), or it was sent there. */
const planMovesDown = (x: Dec): boolean =>
  x.requestedTier !== null && ((x.planTier !== null && tierRank(x.planTier) < tierRank(x.requestedTier)) || (x.routed && x.sentTier !== null && tierRank(x.sentTier) < tierRank(x.requestedTier)));

export interface WorkProfile {
  readonly requests: Readonly<Record<WorkCategory, number>>;
  readonly tokens: Readonly<Record<WorkCategory, number>>;
  readonly total: number;
  /** Work units: a new turn (main chat or subagent) and the continuations of its conversation up to the next new turn. */
  readonly units: number;
  readonly touchableUnits: number;
  /** New turns whose plan has no target and that never reached the backend (guard refusal before it, errors, no key). */
  readonly undecidedNew: number;
  /** Continuations with no new turn before them in the log (it started mid-loop): no unit, not touchable. */
  readonly orphanContinuations: number;
  /** Tokens of the units whose plan moved below the requested tier: the most any per-turn routing could have moved. */
  readonly touchable: number;
  readonly touchableSubagent: number;
}

/** Pure. Side calls are never rewritten, so they are never touchable; a loop is touchable when the turn that started it was. */
export function workProfile(d: readonly Dec[]): WorkProfile {
  const requests: Record<WorkCategory, number> = { new: 0, continuation: 0, subagent: 0, side: 0 };
  const tok: Record<WorkCategory, number> = { new: 0, continuation: 0, subagent: 0, side: 0 };
  for (const x of d) {
    requests[workCategory(x)]++;
    tok[workCategory(x)] += tokens(x);
  }
  const byConv = new Map<string, Dec[]>();
  for (const x of d) {
    if (workCategory(x) === "side") continue;
    const k = x.conv ?? `\u0000${x.id}`; // no conversation key: the request is a unit (or an orphan) on its own
    byConv.set(k, [...(byConv.get(k) ?? []), x]);
  }
  let units = 0;
  let touchableUnits = 0;
  let undecidedNew = 0;
  let orphanContinuations = 0;
  let touchable = 0;
  let touchableSubagent = 0;
  for (const list of byConv.values()) {
    list.sort((a, b) => a.atMs - b.atMs);
    let unit: boolean | null = null; // null: no new turn seen yet in this conversation
    for (const x of list) {
      if (x.turn === "new") {
        units++;
        unit = planMovesDown(x);
        if (unit) touchableUnits++;
        if (!x.decided && x.planTier === null) undecidedNew++;
      } else if (unit === null) orphanContinuations++;
      if (unit) {
        touchable += tokens(x);
        if (x.kind === "subagent") touchableSubagent += tokens(x);
      }
    }
  }
  return { requests, tokens: tok, total: sum(Object.values(tok)), units, touchableUnits, undecidedNew, orphanContinuations, touchable, touchableSubagent };
}

/** Shown per session before the list is cut. */
const MAX_SESSION_ROWS = 20;
/** Below this many sessions on either side the delegation comparison says so. */
export const MIN_DELEGATION_SESSIONS = 5;
const HINT_OFF = "off";

export interface HintArm {
  /** Hint version, or "off" (REFLEX_DELEGATE off, or records from before it existed). */
  readonly hint: string;
  readonly sessions: number;
  /** `delegate_hint` records: hints actually returned to Claude Code in these sessions. */
  readonly delivered: number;
  readonly userTurns: number;
  readonly tokens: number;
  readonly usdAtSent: number;
  readonly subagentTokens: number;
  readonly sideTokens: number;
}

/** Sessions grouped by the delegation hint their decision records carry; all their requests, side calls included. */
export function hintArms(rec: Records): HintArm[] {
  const bySession = new Map<string, Dec[]>();
  for (const x of rec.decisions) bySession.set(x.session ?? "?", [...(bySession.get(x.session ?? "?") ?? []), x]);
  const arms = new Map<string, { sessions: Set<string>; d: Dec[] }>();
  for (const [s, v] of bySession) {
    const hint = v.find((x) => x.hint !== null)?.hint ?? HINT_OFF;
    const a = arms.get(hint) ?? { sessions: new Set<string>(), d: [] };
    a.sessions.add(s);
    a.d.push(...v);
    arms.set(hint, a);
  }
  return [...arms.entries()]
    .map(([hint, a]) => {
      const p = workProfile(a.d);
      return {
        hint,
        sessions: a.sessions.size,
        delivered: rec.hints.filter((h) => a.sessions.has(h.session ?? "?")).length,
        userTurns: p.requests.new,
        tokens: p.total,
        usdAtSent: costOf(a.d).atSentUsd,
        subagentTokens: p.tokens.subagent,
        sideTokens: p.tokens.side,
      };
    })
    .sort((a, b) => (a.hint === HINT_OFF ? -1 : b.hint === HINT_OFF ? 1 : a.hint.localeCompare(b.hint)));
}
const perTurn = (v: number, turns: number): number | null => (turns === 0 ? null : v / turns);

/** 0. Workflow profile: where the tokens go, and how much of them per-turn routing could reach at all. */
export function s0Workflow({ rec }: Ctx): string[] {
  const d = rec.decisions;
  if (d.length === 0) return NONE;
  const sessions = new Map<string, Dec[]>();
  for (const x of [...d].sort((a, b) => a.atMs - b.atMs)) sessions.set(x.session ?? "?", [...(sessions.get(x.session ?? "?") ?? []), x]);
  const userTurns = (v: readonly Dec[]): number => v.filter((x) => workCategory(x) === "new").length;
  const perSession = [...sessions.values()].map(userTurns);
  const out = [
    "  tokens = input + output + cache read + cache write of each classified request; each request counts once",
    `  ${sessions.size} session${sessions.size === 1 ? "" : "s"}; user turns (main-chat new turns) per session: p50 ${int(median(perSession))}, max ${int(Math.max(...perSession))}`,
    ...table([
      ["session", "user turns", "subagent runs", "requests", "tokens"],
      ...[...sessions.entries()].slice(0, MAX_SESSION_ROWS).map(([s, v]) => [s.slice(0, 8), String(userTurns(v)), String(v.filter((x) => x.kind === "subagent" && x.turn === "new").length), String(v.length), int(sum(v.map(tokens)))]),
    ], "    "),
  ];
  if (sessions.size > MAX_SESSION_ROWS) out.push(`    ... ${sessions.size - MAX_SESSION_ROWS} more session(s)`);
  const p = workProfile(d);
  const label: Record<WorkCategory, string> = {
    new: "(a) new turns, main chat",
    continuation: "(b) tool-loop continuations, main chat",
    subagent: "(c) subagents (first request and loop)",
    side: "(d) side calls",
  };
  out.push("", "  where the tokens went:", ...table([
    ["category", "requests", "tokens", "% tokens"],
    ...(["new", "continuation", "subagent", "side"] as const).map((c) => [label[c], String(p.requests[c]), int(p.tokens[c]), pct(p.tokens[c], p.total)]),
    ["total", String(d.length), int(p.total), pct(p.total, p.total)],
  ], "    "));
  out.push(`  work units (a new turn and its continuations): ${p.units}; ${p.touchableUnits} with a plan below the requested tier (ignoring the cost guard)${p.undecidedNew > 0 ? `; ${p.undecidedNew} new turn(s) without a decision count as not touchable` : ""}${p.orphanContinuations > 0 ? `; ${p.orphanContinuations} continuation(s) before any new turn count as not touchable` : ""}`);
  const arms = hintArms(rec);
  out.push("", `  by delegation hint (REFLEX_DELEGATE; "${HINT_OFF}" = not set or recorded before it existed); $ = the tokens at the sent model's list price, an estimate (section 8):`, ...table([
    ["hint", "sessions", "hints delivered", "user turns", "tokens", "tokens per user turn", "$ at sent", "$ per user turn", "subagent share", "side-call share"],
    ...arms.map((a) => [a.hint, String(a.sessions), a.hint === HINT_OFF ? "-" : String(a.delivered), String(a.userTurns), int(a.tokens), int(perTurn(a.tokens, a.userTurns)), usd(a.usdAtSent), a.userTurns === 0 ? "-" : usd(a.usdAtSent / a.userTurns), pct(a.subagentTokens, a.tokens), pct(a.sideTokens, a.tokens)]),
  ], "    "));
  out.push(`  routing can touch at most ${pct(p.touchable, p.total)} of your tokens; ${pct(p.touchableSubagent, p.touchable)} of that is in subagents`);
  return out;
}

/** 1. Decisions by kind, turn and tier (requested -> sent), mode and degraded reasons. */
export function s1Decisions({ rec }: Ctx): string[] {
  const d = rec.decisions;
  if (d.length === 0) return NONE;
  const out: string[] = [`  ${d.length} classified requests`];
  const turns = ["new", "continuation", "side", "unknown"].filter((t) => d.some((x) => x.turn === t));
  const kinds = [...new Set(d.map((x) => x.kind))].sort();
  out.push("", "  by kind and turn:", ...table([["kind", ...turns], ...kinds.map((k) => [k, ...turns.map((t) => String(d.filter((x) => x.kind === k && x.turn === t).length))])], "    "));
  const sides = countBy(d.filter((x) => x.turn === "side"), (x) => x.sideKind ?? "unknown");
  if (sides.length > 0) out.push("", `  side calls by kind: ${sides.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  const used = new Set(d.flatMap((x) => [tl(x.requestedTier), tl(x.sentTier)]));
  const cols = tierCols(used);
  out.push("", "  tier, requested (rows) -> sent (columns):", ...table([["requested", ...cols], ...cols.map((r) => [r, ...cols.map((c) => String(d.filter((x) => tl(x.requestedTier) === r && tl(x.sentTier) === c).length))])], "    "));
  out.push("", `  mode requested -> effective: ${countBy(d, (x) => `${x.modeRequested ?? "?"} -> ${x.modeEffective ?? "?"}`).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  const deg = countBy(d.filter((x) => x.degradedReason !== null), (x) => x.degradedReason!);
  out.push(`  degraded: ${deg.length === 0 ? "none" : deg.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  return out;
}

/** What a rule would route to, given the requested tier: never above it (upgrades are off by default) and, for argmax, only down with enough confidence. */
export function wouldRoute(rule: "mass" | "argmax", d: Dec): Tier | null {
  if (d.requestedTier === null) return null;
  const pick = rule === "mass" ? d.pickMass : d.pickArgmax && (d.pickArgmax.confidence ?? 0) >= DOWNGRADE_MIN_CONFIDENCE ? d.pickArgmax.value : d.requestedTier;
  if (pick === null) return null;
  return tierRank(pick) < tierRank(d.requestedTier) ? pick : d.requestedTier;
}

/** 2. mass vs argmax: agreement matrix and what each rule would have routed. */
export function s2MassVsArgmax({ rec }: Ctx): string[] {
  const decided = newTurns(rec.decisions).filter((x) => x.decided);
  if (decided.length === 0) return NONE;
  const both = decided.filter((x) => x.pickMass !== null && x.pickArgmax?.value != null);
  const out = [`  ${decided.length} new turns reached the backend; ${both.length} log both readings (older records log only the applied pick)`];
  if (both.length === 0) return out;
  const cols = tierCols(new Set(both.flatMap((x) => [tl(x.pickMass), tl(x.pickArgmax!.value)])));
  out.push("", "  agreement, mass pick (rows) x argmax pick (columns):", ...table([["mass \\ argmax", ...cols], ...cols.map((r) => [r, ...cols.map((c) => String(both.filter((x) => tl(x.pickMass) === r && tl(x.pickArgmax!.value) === c).length))])], "    "));
  const agree = both.filter((x) => x.pickMass === x.pickArgmax!.value).length;
  out.push(`  agree on ${agree} of ${both.length} (${pct(agree, both.length)})`);
  const routable = both.filter((x) => x.requestedTier !== null);
  const rows = (["mass", "argmax"] as const).map((rule) => {
    const w = routable.map((x) => wouldRoute(rule, x)!);
    return [rule, ...TIERS.filter((t) => routable.some((x) => wouldRoute("mass", x) === t || wouldRoute("argmax", x) === t)).map((t) => String(w.filter((v) => v === t).length)), String(routable.filter((x) => tierRank(wouldRoute(rule, x)!) < tierRank(x.requestedTier!)).length)];
  });
  const tiersShown = TIERS.filter((t) => routable.some((x) => wouldRoute("mass", x) === t || wouldRoute("argmax", x) === t));
  out.push("", `  what each rule would route to (n=${routable.length}; ignores guard, veto and context ceiling; argmax moves down only at confidence >= ${DOWNGRADE_MIN_CONFIDENCE}):`, ...table([["rule", ...tiersShown, "moved down"], ...rows], "    "));
  const massLower = routable.filter((x) => tierRank(wouldRoute("mass", x)!) < tierRank(wouldRoute("argmax", x)!)).length;
  const argmaxLower = routable.filter((x) => tierRank(wouldRoute("argmax", x)!) < tierRank(wouldRoute("mass", x)!)).length;
  out.push(`  they differ on ${massLower + argmaxLower}: mass routes lower on ${massLower}, argmax on ${argmaxLower}`);
  return out;
}

/** 3. Shadow vs actual: requested tier x would-route tier with the share of tokens, and requested vs sent model for routed records. */
export function s3ShadowVsActual({ rec }: Ctx): string[] {
  const decided = newTurns(rec.decisions).filter((x) => x.decided && x.requestedTier !== null);
  const out: string[] = [];
  if (decided.length === 0) out.push(...NONE);
  else {
    const totalTok = sum(decided.map(tokens));
    const cells = new Map<string, Dec[]>();
    for (const x of decided) {
      const k = `${x.requestedTier}\u0000${tl(x.planTier ?? x.requestedTier)}`;
      cells.set(k, [...(cells.get(k) ?? []), x]);
    }
    const rows = [...cells.entries()]
      .map(([k, v]) => ({ req: k.split("\u0000")[0]!, would: k.split("\u0000")[1]!, v }))
      .sort((a, b) => tierRank(a.req as Tier) - tierRank(b.req as Tier) || TIERS.indexOf(a.would as Tier) - TIERS.indexOf(b.would as Tier));
    out.push(`  new turns that reached the backend (n=${decided.length}); tokens = input + output + cache read + cache write of that turn's own request`, ...table([
      ["requested", "would route to", "turns", "% turns", "% tokens", "actually sent there"],
      ...rows.map((r) => [r.req, r.would, String(r.v.length), pct(r.v.length, decided.length), pct(sum(r.v.map(tokens)), totalTok), String(r.v.filter((x) => tl(x.sentTier) === r.would).length)]),
    ], "    "));
  }
  const routed = rec.decisions.filter((x) => x.routed);
  out.push("", `  routed records (rewritten and accepted; includes pinned continuations): ${routed.length}`);
  if (routed.length > 0) out.push(...table([["requested model", "sent model", "records"], ...countBy(routed, (x) => `${x.requestedModel ?? "?"}\u0000${x.sentModel ?? "?"}`).map(([k, n]) => [...k.split("\u0000"), String(n)])], "    "));
  return out;
}

/** 4. Guard skips. */
export function s4Guard({ rec }: Ctx): string[] {
  const g = rec.decisions.filter((x) => x.guard !== null);
  if (g.length === 0) return ["  (no records with a guard evaluation; the guard runs in route mode only)"];
  const reasons = countBy(g, (x) => x.guard!.reason).map(([r]) => r);
  const rows = reasons.map((r) => {
    const v = g.filter((x) => x.guard!.reason === r);
    const pen = v.map((x) => x.guard!.penaltyUsd).filter((p): p is number => p !== null && p > 0);
    return [r, String(v.length), String(v.filter((x) => x.guard!.allowed).length), String(v.filter((x) => !x.guard!.allowed).length), pen.length ? `$${median(pen)!.toFixed(4)}` : "-", pen.length ? `$${Math.max(...pen).toFixed(4)}` : "-"];
  });
  const blocked = g.filter((x) => !x.guard!.allowed);
  const skipped = blocked.filter((x) => !x.decided);
  return [
    `  ${g.length} guard evaluations, ${blocked.length} refused`,
    ...table([["reason", "evaluated", "allowed", "refused", "penalty p50", "penalty max"], ...rows], "    "),
    `  refused before the backend was asked (backend call skipped): ${skipped.length} of ${blocked.length} refusals`,
  ];
}

/** 5. Fallbacks and breaker. */
export function s5Fallbacks({ rec }: Ctx): string[] {
  const d = rec.decisions;
  if (d.length === 0) return NONE;
  const fb = d.filter((x) => x.fallback);
  const out = [`  rewrites rejected by the upstream and re-sent with the original bytes: ${fb.length}`];
  if (fb.length > 0) {
    out.push(...table([["status", "records"], ...countBy(fb, (x) => String(x.fallbackStatus ?? "?")).map(([k, n]) => [k, String(n)])], "    "));
    const errs = countBy(fb.filter((x) => x.fallbackError !== null), (x) => x.fallbackError!.slice(0, 100));
    for (const [e, n] of errs) out.push(`    ${n}x ${e}`);
    if (fb.some((x) => x.fallbackError === null)) out.push(`    ${fb.filter((x) => x.fallbackError === null).length}x (no error text: recorded before fallback_error existed)`);
  }
  const count = (reason: string): number => d.filter((x) => x.reasons.includes(reason)).length;
  out.push(`  tier switched off after a rejection (tier_disabled): ${count("tier_disabled")}`);
  out.push(`  rewrite_failed: ${count("rewrite_failed")}, stay_pinned_backend_error: ${count("stay_pinned_backend_error")}`);
  const errors = countBy(d.filter((x) => x.error !== null), (x) => x.error!);
  out.push(`  breaker_open: ${d.filter((x) => x.error === "breaker_open").length}`);
  out.push(`  backend and pipeline errors: ${errors.length === 0 ? "none" : errors.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  return out;
}

/** 6. Latency: Jev p50/p95 by connection; added route latency. */
export function s6Latency({ rec }: Ctx): string[] {
  const d = rec.decisions;
  const withLatency = d.filter((x) => x.latencyMs !== null);
  const out: string[] = [];
  if (withLatency.length === 0) out.push("  Jev decision latency: no decided requests");
  else {
    const groups = [["all", withLatency], ...(["new", "reused"] as const).map((c) => [`${c} connection`, withLatency.filter((x) => x.connection === c)] as const), ["connection not logged", withLatency.filter((x) => x.connection === null)]] as const;
    out.push("  Jev decision latency (nearest-rank percentiles):", ...table([["", "n", "p50", "p95"], ...groups.filter(([, v]) => v.length > 0).map(([name, v]) => [name, String(v.length), ms(percentile(v.map((x) => x.latencyMs!), 50)), ms(percentile(v.map((x) => x.latencyMs!), 95))])], "    "));
  }
  // msToHeaders is measured from the request's arrival: in route mode it is the decision wait, the router's own work and the
  // upstream's first byte (the `timing` block splits them; records from before it existed have only the total).
  const nt = newTurns(d).filter((x) => x.msToHeaders !== null && x.modeEffective === "route");
  const arms = [
    ["routed (after a decision)", nt.filter((x) => x.routed)],
    ["unrouted, after a decision", nt.filter((x) => !x.routed && x.decided)],
    ["unrouted, no decision made (guard refusal, backend failure)", nt.filter((x) => !x.routed && !x.decided)],
  ] as const;
  const pc = (v: readonly (number | null)[], p: number): string => {
    const xs = v.filter((n): n is number => n !== null);
    return xs.length === 0 ? "-" : ms(percentile(xs, p));
  };
  out.push("", "  time to upstream response headers, new turns in route mode, split into the wait for the decision and the upstream's first byte (different models and prompts, so a rough comparison only):");
  if (nt.length === 0) out.push("    no new turns in route mode");
  else {
    out.push(...table([
      ["", "n", "headers p50", "headers p95", "decision wait p50", "decision wait p95", "upstream first byte p50", "upstream first byte p95"],
      ...arms.filter(([, v]) => v.length > 0).map(([name, v]) => [name, String(v.length), pc(v.map((x) => x.msToHeaders), 50), pc(v.map((x) => x.msToHeaders), 95), pc(v.map((x) => x.decisionWaitMs), 50), pc(v.map((x) => x.decisionWaitMs), 95), pc(v.map((x) => x.upstreamFirstByteMs), 50), pc(v.map((x) => x.upstreamFirstByteMs), 95)]),
    ], "    "));
    const legacy = nt.filter((x) => x.decisionWaitMs === null).length;
    if (legacy > 0) out.push(`    ${legacy} of ${nt.length} of these records predate the timing block: they count in n and "headers" but not in the two components`);
  }
  // A decision that timed out must not have held the request longer than the deadline plus the router's grace.
  const timedOut = newTurns(d).filter((x) => x.modeEffective === "route" && x.error !== null && /^(backend:timeout|decision_late)/.test(x.error));
  if (timedOut.length > 0) {
    const timed = timedOut.filter((x) => x.decisionWaitMs !== null && x.decisionDeadlineMs !== null);
    const over = timed.filter((x) => x.decisionWaitMs! > x.decisionDeadlineMs! + DECISION_GRACE_MS);
    const longest = timed.length === 0 ? null : Math.max(...timed.map((x) => x.decisionWaitMs!));
    out.push(`  timed-out decisions in route mode: ${timedOut.length}; ${timed.length} with timing${longest === null ? " (cannot be checked against the deadline: recorded before the timing block)" : `, longest wait ${ms(longest)}, deadline ${[...new Set(timed.map((x) => x.decisionDeadlineMs))].join("/")} ms + ${DECISION_GRACE_MS} ms grace: ${over.length === 0 ? "all within" : `${over.length} EXCEEDED it`}`}`);
  }
  return out;
}

export interface OutcomeGroup {
  readonly scope: string;
  /** `interjection`: a window sharing its decision with the turn that owns it; never counted inside a rate. */
  readonly arm: "routed" | "unchanged" | "interjection" | "no decision";
  readonly windows: readonly OutcomeRec[];
  /** Windows with a revert found later (`outcome_update`) or in the window. */
  readonly reverted: ReadonlySet<OutcomeRec>;
}

const ARM_ORDER: readonly OutcomeGroup["arm"][] = ["routed", "unchanged", "interjection", "no decision"];

/** Joins outcome windows to their decision: routed (the decision's request was rewritten) vs unchanged. */
export function outcomeGroups(ctx: Ctx): OutcomeGroup[] {
  const revertedIds = new Set(ctx.rec.updates.filter((u) => u.signal === "reverted_edit").map((u) => u.decisionId));
  const map = new Map<string, OutcomeRec[]>();
  for (const o of ctx.rec.outcomes) {
    const dec = o.decisionId === null ? undefined : ctx.byId.get(o.decisionId);
    // An interjection window shares its decision with the turn that owns it. Counting it in that decision's arm would
    // inflate n and count the turn's edits twice, so it gets an arm of its own and never enters a rate.
    const arm = o.attribution === "interjection" ? "interjection" : dec === undefined ? "no decision" : dec.routed ? "routed" : "unchanged";
    const k = `${o.scope}\u0000${arm}`;
    map.set(k, [...(map.get(k) ?? []), o]);
  }
  return [...map.entries()]
    .map(([k, windows]) => {
      const [scope, arm] = k.split("\u0000") as [string, OutcomeGroup["arm"]];
      return { scope, arm, windows, reverted: new Set(windows.filter((w) => w.revertedInWindow || (w.decisionId !== null && revertedIds.has(w.decisionId)))) };
    })
    .sort((a, b) => a.scope.localeCompare(b.scope) || ARM_ORDER.indexOf(a.arm) - ARM_ORDER.indexOf(b.arm));
}

/** 7. Outcome rates for routed vs unchanged turns. */
export function s7Outcomes(ctx: Ctx): string[] {
  const groups = outcomeGroups(ctx);
  if (groups.length === 0) return ["  (no outcome records; outcome capture runs in shadow and route sessions since M4)"];
  const out: string[] = [];
  for (const g of groups) {
    const w = g.windows;
    const scored = w.filter((x) => x.correctionScore !== null);
    const withEdits = w.filter((x) => x.edits > 0);
    const head = `  ${g.scope} / ${g.arm}: ${w.length} window${w.length === 1 ? "" : "s"}`;
    if (g.arm === "interjection") {
      const joined = w.filter((x) => x.decisionId !== null).length;
      out.push(`${head}: messages typed mid-tool-loop, joined to the turn's own decision (${joined} joined). Kept out of the rates above: they share a decision with that turn, so counting them would inflate n and count its edits twice`);
      continue;
    }
    if (g.arm === "no decision") {
      const reasons = countBy(w, (x) => x.noDecisionReason ?? "not recorded");
      out.push(`${head} (${reasons.map(([k, n]) => `${k} ${n}`).join(", ")}); not attributable to a routing decision`);
      continue;
    }
    const buckets = [["0", scored.filter((x) => x.correctionScore === 0).length], ["0-0.5", scored.filter((x) => x.correctionScore! > 0 && x.correctionScore! < 0.5).length], [">=0.5", scored.filter((x) => x.correctionScore! >= 0.5).length]] as const;
    out.push(head);
    out.push(`    correction score: ${scored.length} scored (${w.length - scored.length} had no next prompt): ${buckets.map(([k, n]) => `${k}: ${n}`).join(", ")}`);
    out.push(`    test failure after an edit: ${w.filter((x) => x.testFailureAfterEdit).length} of ${withEdits.length} windows with edits (${w.filter((x) => x.testRuns > 0).length} windows ran tests)`);
    out.push(`    reverted edits: ${withEdits.filter((x) => g.reverted.has(x)).length} of ${withEdits.length} windows with edits`);
    if (w.length < MIN_OUTCOME_N) out.push(`    insufficient data: n=${w.length} < ${MIN_OUTCOME_N}; no rates shown`);
    else {
      out.push(`    rates: correction > 0 in ${pct(scored.filter((x) => x.correctionScore! > 0).length, scored.length)} of scored; test failure ${pct(w.filter((x) => x.testFailureAfterEdit).length, withEdits.length)} and revert ${pct(withEdits.filter((x) => g.reverted.has(x)).length, withEdits.length)} of windows with edits`);
    }
  }
  const arms = new Set(groups.filter((g) => g.arm !== "no decision" && g.windows.length >= MIN_OUTCOME_N).map((g) => `${g.scope}/${g.arm}`));
  const scopes = new Set(groups.map((g) => g.scope));
  for (const s of scopes) if (!(arms.has(`${s}/routed`) && arms.has(`${s}/unchanged`))) out.push(`  ${s}: routed vs unchanged is not comparable yet (each arm needs n >= ${MIN_OUTCOME_N})`);
  if (ctx.rec.harnessInjected.length > 0) out.push(`  harness_injected records: ${ctx.rec.harnessInjected.length}`);
  return out;
}

const PRICED_TTL = "5m" as const;

export interface CostRow {
  readonly n: number;
  readonly tokens: number;
  readonly atSentUsd: number;
  readonly atRequestedUsd: number;
}

/** The same token counts priced at the model actually sent and at the model requested. Records without usage or a known tier are skipped. */
export function costOf(d: readonly Dec[]): CostRow {
  let n = 0;
  let tok = 0;
  let sent = 0;
  let requested = 0;
  for (const x of d) {
    if (x.usage === null || x.sentTier === null || x.requestedTier === null) continue;
    n++;
    tok += totalTokens(x.usage);
    sent += usageCostUsd(x.sentTier, x.usage, PRICED_TTL);
    requested += usageCostUsd(x.requestedTier, x.usage, PRICED_TTL);
  }
  return { n, tokens: tok, atSentUsd: sent, atRequestedUsd: requested };
}

/** 8. Cost at list prices (estimate). */
export function s8Cost({ rec, usd: showUsd }: Ctx): string[] {
  const work = rec.decisions.filter((x) => x.turn !== "side");
  const routed = work.filter((x) => x.routed);
  const all = costOf(work);
  const r = costOf(routed);
  const out = [
    `  ESTIMATE at list prices (src/pricing.ts, last verified ${LAST_VERIFIED}): the same token counts priced at the model sent vs the model requested.`,
    "  Not modelled: tokenizer differences between models, cache TTL (writes priced at the 5-minute rate), discounts, subscription limits.",
    "  The requested-model figure prices the routed model's cache writes as writes on the requested model too, although its cache was usually already warm from side calls (observations.md, cache cost model), so it overstates what staying would have cost.",
  ];
  if (all.n === 0) return [...out, "  no records with usage"];
  const line = (name: string, c: CostRow): string[] => [
    name, String(c.n), int(c.tokens), c.atRequestedUsd === 0 ? "-" : pct(c.atSentUsd, c.atRequestedUsd), ...(showUsd ? [usd(c.atRequestedUsd), usd(c.atSentUsd), usd(c.atRequestedUsd - c.atSentUsd)] : []),
  ];
  out.push(...table([
    ["main chat + subagent requests", "n", "tokens", "usage at sent as % of at requested", ...(showUsd ? ["$ at requested", "$ at sent", "$ difference"] : [])],
    line("routed only", r),
    line("all (unrouted count as equal)", all),
  ], "    "));
  if (!showUsd) out.push("  Dollar amounts: rerun with --usd. Without it only relative usage is shown.");
  out.push("  Side calls are excluded here and shown in section 9.");
  out.push(...delegationLine(hintArms(rec), showUsd));
  return out;
}

/** The delegation comparison for section 8: sessions with each hint version vs without, all requests (side calls included). */
function delegationLine(arms: readonly HintArm[], showUsd: boolean): string[] {
  const off = arms.find((a) => a.hint === HINT_OFF);
  const on = arms.filter((a) => a.hint !== HINT_OFF);
  if (on.length === 0) return ["  delegation: no session ran with the hint (REFLEX_DELEGATE=1); nothing to compare"];
  const arm = (name: string, a: HintArm | undefined): string =>
    a === undefined ? `${name} (n=0 sessions)`
    : `${name} (n=${a.sessions} session${a.sessions === 1 ? "" : "s"}, ${a.userTurns} user turn${a.userTurns === 1 ? "" : "s"}): subagent share ${pct(a.subagentTokens, a.tokens)}, ${int(perTurn(a.tokens, a.userTurns))} tokens${showUsd ? ` and ${a.userTurns === 0 ? "-" : usd(a.usdAtSent / a.userTurns)}` : ""} per user turn`;
  const few = [off, ...on].some((a) => (a?.sessions ?? 0) < MIN_DELEGATION_SESSIONS);
  return [`  delegation (all requests incl. side calls, per user turn; different sessions and tasks, not a controlled comparison${few ? `; fewer than ${MIN_DELEGATION_SESSIONS} sessions on a side: too few to compare` : ""}): ${[...on.map((a) => arm(`with ${a.hint}`, a)), arm("without", off)].join("; ")}`];
}

/** 9. Side-call usage on its own line. */
export function s9SideCalls({ rec, usd: showUsd }: Ctx): string[] {
  const side = rec.decisions.filter((x) => x.turn === "side");
  if (side.length === 0) return NONE;
  const withUsage = side.filter((x) => x.usage !== null);
  const out = [`  ${side.length} side calls (${withUsage.length} with usage). Harness side calls are never rewritten, so they bill the requested model even while the conversation is routed.`];
  const kinds = countBy(side, (x) => x.sideKind ?? "unknown").map(([k]) => k);
  const rows = kinds.map((k) => {
    const v = withUsage.filter((x) => (x.sideKind ?? "unknown") === k);
    return [k, String(side.filter((x) => (x.sideKind ?? "unknown") === k).length), int(sum(v.map(tokens))), ...(showUsd ? [usd(costOf(v).atRequestedUsd)] : [])];
  });
  out.push(...table([["side kind", "calls", "tokens", ...(showUsd ? ["$ at requested model"] : [])], ...rows, ["total", String(side.length), int(sum(withUsage.map(tokens))), ...(showUsd ? [usd(costOf(withUsage).atRequestedUsd)] : [])]], "    "));
  const routedSide = side.filter((x) => x.sentTier !== x.requestedTier).length;
  out.push(`  side calls sent to a model other than the requested one: ${routedSide}${routedSide > 0 ? " (unexpected)" : ""}`);
  return out;
}

export type MoveType = "down" | "up_one_tier" | "back_to_requested" | "stayed";

/**
 * Classifies each main-chat and subagent request by how its sent tier compares with the previous request of the same
 * conversation (the first request compares with the requested tier). `stayed` is kept for new turns only, as a baseline.
 */
export function classifyMoves(d: readonly Dec[]): { move: MoveType; dec: Dec }[] {
  const byConv = new Map<string, Dec[]>();
  for (const x of d) {
    if (x.turn === "side" || x.conv === null || x.usage === null || x.sentTier === null || x.requestedTier === null) continue;
    byConv.set(x.conv, [...(byConv.get(x.conv) ?? []), x]);
  }
  const out: { move: MoveType; dec: Dec }[] = [];
  for (const list of byConv.values()) {
    list.sort((a, b) => a.atMs - b.atMs);
    let prev: Tier | null = null;
    for (const x of list) {
      const from: Tier = prev ?? x.requestedTier!;
      const to = x.sentTier!;
      prev = to;
      if (to === from) {
        if (x.turn === "new") out.push({ move: "stayed", dec: x });
      } else if (tierRank(to) < tierRank(from)) out.push({ move: "down", dec: x });
      else out.push({ move: to === x.requestedTier ? "back_to_requested" : "up_one_tier", dec: x });
    }
  }
  return out;
}

/** 10. Cache writes by move type. */
export function s10CacheMoves({ rec }: Ctx): string[] {
  const moves = classifyMoves(rec.decisions);
  if (moves.length === 0) return NONE;
  const label: Record<MoveType, string> = { down: "down (to a cheaper tier)", up_one_tier: "up, short of the requested tier", back_to_requested: "back to the requested tier", stayed: "stayed (new turns, baseline)" };
  const rows = (["down", "up_one_tier", "back_to_requested", "stayed"] as const).flatMap((m) => {
    const v = moves.filter((x) => x.move === m).map((x) => x.dec.usage!);
    if (v.length === 0) return [];
    const w = v.map((u) => u.cacheCreate);
    return [[label[m], String(v.length), int(median(w)), int(mean(w)), int(Math.max(...w)), int(median(v.map((u) => u.cacheRead)))]];
  });
  return [
    "  first request after a tier change in a conversation (observations.md: moving up one tier can write more than returning to the requested model)",
    ...table([["move", "n", "cache write p50", "cache write mean", "cache write max", "cache read p50"], ...rows], "    "),
  ];
}

/** Fields that vary with the conversation's length, not with the kind of call: left out when grouping fingerprints. */
const COUNT_FIELD = "messages";
const VOLATILE = new Set([COUNT_FIELD, "roles"]);
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : typeof v === "object" && v !== null ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;

export interface FingerprintGroup {
  readonly n: number;
  readonly tokens: number;
  readonly kinds: readonly string[];
  readonly claude_versions: readonly string[];
  readonly message_count: { readonly min: number; readonly max: number };
  /** The most recent fingerprint of the group, complete. */
  readonly fingerprint: Readonly<Record<string, unknown>>;
}

/** Unclassified side calls with a fingerprint, grouped by everything but their length; most frequent first. */
export function fingerprintGroups(d: readonly Dec[]): FingerprintGroup[] {
  const groups = new Map<string, Dec[]>();
  for (const x of d) {
    if (x.fingerprint === null) continue;
    const k = JSON.stringify(canonical(Object.fromEntries(Object.entries(x.fingerprint).filter(([f]) => !VOLATILE.has(f)).map(([f, v]) => [f, f === "last" && typeof v === "object" && v !== null ? { ...v, text_chars: undefined } : v]))));
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  return [...groups.values()]
    .map((v) => {
      const sorted = [...v].sort((a, b) => a.atMs - b.atMs);
      const counts = v.map((x) => num(x.fingerprint![COUNT_FIELD]) ?? 0);
      return {
        n: v.length,
        tokens: sum(v.map(tokens)),
        kinds: [...new Set(v.map((x) => x.kind))].sort(),
        claude_versions: [...new Set(v.map((x) => x.claudeVersion ?? "?"))].sort(),
        message_count: { min: Math.min(...counts), max: Math.max(...counts) },
        fingerprint: canonical(sorted.at(-1)!.fingerprint) as Record<string, unknown>,
      };
    })
    .sort((a, b) => b.n - a.n || b.tokens - a.tokens);
}

/** 11. Unclassified side calls: their structural fingerprints, to be sent back and given a side_kind. */
export function s11Fingerprints({ rec }: Ctx): string[] {
  const un = rec.decisions.filter((x) => x.turn === "side" && x.sideKind === "unclassified");
  if (un.length === 0) return ["  (no unclassified side calls)"];
  const groups = fingerprintGroups(un);
  const without = un.filter((x) => x.fingerprint === null).length;
  const out = [
    `  ${un.length} unclassified side call${un.length === 1 ? "" : "s"}, ${int(sum(un.map(tokens)))} tokens; ${groups.length} distinct fingerprint${groups.length === 1 ? "" : "s"}${without > 0 ? `; ${without} without one (recorded before fingerprints existed, or not buildable)` : ""}`,
    "  Structure only (docs/privacy.md). `reflex report --fingerprints` prints them as JSON lines to send back.",
  ];
  for (const g of groups) out.push(`    n=${g.n}, ${int(g.tokens)} tokens, kind ${g.kinds.join("/")}, claude ${g.claude_versions.join("/")}, messages ${g.message_count.min === g.message_count.max ? g.message_count.min : `${g.message_count.min}-${g.message_count.max}`}: ${JSON.stringify(g.fingerprint)}`);
  return out;
}

export const SECTIONS: readonly { readonly title: string; readonly run: (c: Ctx) => string[] }[] = [
  { title: "0. Workflow profile", run: s0Workflow },
  { title: "1. Decisions by kind, turn and tier", run: s1Decisions },
  { title: "2. mass vs argmax", run: s2MassVsArgmax },
  { title: "3. Shadow vs actual", run: s3ShadowVsActual },
  { title: "4. Guard skips", run: s4Guard },
  { title: "5. Fallbacks and breaker", run: s5Fallbacks },
  { title: "6. Latency", run: s6Latency },
  { title: "7. Outcome rates, routed vs unchanged", run: s7Outcomes },
  { title: "8. Cost at list prices (estimate)", run: s8Cost },
  { title: "9. Side-call usage", run: s9SideCalls },
  { title: "10. Cache writes by move type", run: s10CacheMoves },
  { title: "11. Unclassified side-call fingerprints", run: s11Fingerprints },
];
