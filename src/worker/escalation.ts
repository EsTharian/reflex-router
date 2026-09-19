// Auto-escalation (REFLEX_ESCALATE=1, off by default): the one place where a past outcome changes a future request.
//
// Scope and limits, all enforced here so the router only has to ask one question:
//  - it may only RAISE a tier, never lower one, and never above the tier the client asked for;
//  - it applies to a conversation's next main-chat `new` turns only: never to a pinned tool-loop continuation, never
//    to a side call, never to a subagent's own conversation;
//  - it raises the FLOOR the cost guard evaluates against; it does not overrule the guard, and it never blocks;
//  - the state is in memory. A worker restart loses it, which is the correct fail-open behaviour.
//
// The lever is weaker than "the failed turn is retried on a better model": that turn is over and billed. It is "the
// turn in which the user says it went wrong is itself routed up".
import { TIERS, type Config, type EscalateTarget, type Tier } from "../config.js";
import { clampUp } from "../policy.js";
import { tierRank } from "../tiers.js";

/** Which outcome signal raised the conversation. Recorded as `escalated:<signal>` on the decision's reasons. */
export type EscalationSignal = "correction" | "test_failure" | "reverted_edit";

/** What the outcome tracker hands the router when a routed window closes with a signal. */
export interface EscalationEvent {
  /** Conversation key of the window's decision; escalation is per conversation, like the pin. */
  readonly conv: string;
  readonly signal: EscalationSignal;
  /** The correction score that fired, when the signal was `correction`; null otherwise. */
  readonly score: number | null;
  /** The decision whose window produced the signal, so the report can join cause to effect. */
  readonly decisionId: string | null;
  /** Turn seq the signal was attributed to (see the undo re-attribution in src/outcome/tracker.ts). */
  readonly turnSeq: number;
}

/** Per-conversation escalation state. `remaining` counts the new turns this signal still covers. */
export interface EscalationState {
  readonly signal: EscalationSignal;
  readonly score: number | null;
  readonly decisionId: string | null;
  readonly turnSeq: number;
  remaining: number;
}

/**
 * A second signal inside the window restarts the count, it does not stack: with a ceiling of the requested tier there
 * is nothing to stack onto.
 */
export function raise(prev: EscalationState | null, e: EscalationEvent, windowTurns: number): EscalationState {
  void prev;
  return { signal: e.signal, score: e.score, decisionId: e.decisionId, turnSeq: e.turnSeq, remaining: windowTurns };
}

/**
 * Where an escalation sends the turn. Never below `pick`, never above `requested`, and only among the tiers this
 * config enables and whose context ceiling fits `ctx`. Returns null when there is nowhere to go — the caller then
 * routes exactly as it would have.
 *
 * `requested` (the default) goes straight back to the tier the client asked for. `next` goes up one tier. The
 * intuitive choice is `next` and the measurement says it is the expensive one: on the session B rerun
 * (docs/observations.md) moving a Haiku pin up one tier to Sonnet paid 13,385 tokens of cache write, while moving all
 * the way to the requested Opus paid 5,924 — because the harness's own side calls keep the requested model's cache
 * warm for free and nothing keeps the middle tier's warm. `next` can also need a second escalation to get there.
 */
export function escalatedTier(pick: Tier, requested: Tier, target: EscalateTarget, cfg: Pick<Config, "tiers" | "allowFable">, ctx: number | null): Tier | null {
  if (tierRank(pick) >= tierRank(requested)) return null;
  const from = target === "requested" ? requested : TIERS[tierRank(pick) + 1];
  if (from === undefined) return null;
  const up = clampUp(from, cfg, undefined, ctx);
  if (up === null) return null;
  // Never past the requested tier: the worst case stays "the model the client asked for", which is every other
  // fail-open path's worst case too.
  const capped = tierRank(up) > tierRank(requested) ? requested : up;
  return tierRank(capped) > tierRank(pick) ? capped : null;
}

/** Decrements the conversation's escalation by one new turn; returns the state to keep (null once it has decayed). */
export function decay(s: EscalationState): EscalationState | null {
  const remaining = s.remaining - 1;
  return remaining <= 0 ? null : { ...s, remaining };
}
