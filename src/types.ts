// Decision-side types shared by the backend, the policy and the log. Two dimensions: the tier, and (REFLEX_EFFORT) the
// effort level, which is read from the same answers (src/policy.ts effortPlan) and applied by src/wire/effort.ts.
import type { DecisionRule, Tier } from "./config.js";

export type { DecisionRule, Tier } from "./config.js";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Dimension = "tier" | "effort";

// ---- what goes to a decision backend -------------------------------------------------------------------------------

/** One question in the backend's wire format (TypeSafe System One: noul / choice / score). */
export type Question =
  | { readonly type: "choice"; readonly instructions: unknown; readonly criteria: Readonly<Record<string, unknown>> }
  | { readonly type: "score"; readonly instructions: unknown; readonly criteria: readonly unknown[] }
  | { readonly type: "noul"; readonly instructions: unknown; readonly criteria?: { readonly true?: string; readonly false?: string } };

export type QuestionId = string;
export type QuestionSet = Readonly<Record<QuestionId, Question>>;

/** The privacy-budgeted, redacted state. Its keys are an allow-list (docs/privacy.md); nothing else is ever sent. */
export interface DecisionState {
  readonly task: string;
  readonly previous_assistant_reply?: string;
  readonly context: { readonly requesting_tier: Tier | "unknown"; readonly is_subagent: boolean };
}

// ---- what comes back ----------------------------------------------------------------------------------------------

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}
export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}
export interface NoulAnswer {
  readonly type: "noul";
  readonly p: number;
}
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface Decision {
  readonly answers: Readonly<Record<QuestionId, Answer>>;
  readonly latencyMs: number;
  readonly backendModel: string;
  readonly tokensIn: number | null;
  /** Whether the backend call reused an open connection (latency diagnosis); null when not applicable. */
  readonly connection: "new" | "reused" | null;
}

// ---- what the policy makes of it ----------------------------------------------------------------------------------

export interface Picked<V extends string> {
  readonly value: V;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}
/** Both readings of the tier answer, always computed, so shadow data can compare them. */
export interface TierReadings {
  /** Cheapest tier leaving at most eps probability on the tiers above it. */
  readonly mass: { readonly value: Tier; readonly aboveMass: number };
  /** The backend's own choice (highest probability) and its confidence. */
  readonly argmax: { readonly value: Tier; readonly confidence: number };
}
export interface Judgement {
  /** The applied pick (per `rule`); `confidence`/`probabilities` are the backend's answer as given. */
  readonly tier: Picked<Tier>;
  readonly rule: DecisionRule;
  readonly readings: TierReadings;
  readonly effort?: Picked<Effort>;
  /** Cross-checking scores, e.g. reasoning_demand. */
  readonly vetoes: Readonly<Record<string, number>>;
}
export interface Target {
  readonly tier: Tier;
  readonly effort?: Effort;
}

export type ReasonCode =
  | "requested_tier_unknown"
  | "same_tier"
  | "downgrade"
  | "low_confidence"
  | "veto_reasoning_demand"
  | "upgrade_disabled"
  | "upgrade_low_confidence"
  | "upgrade"
  | "clamped_up"
  | "context_ceiling"
  | "no_enabled_tier"
  | "main_chat_disabled"
  | "override"
  | "guard_blocked"
  | "stay_pinned"
  | "stay_pinned_backend_error"
  | "return_up"
  | "tier_disabled"
  | "rewrite_unverified"
  | "rewrite_failed"
  /**
   * REFLEX_ESCALATE=1 only: the conversation's previous routed turn closed with this outcome signal, so this new turn
   * was planned one tier above the policy's pick (never above the requested tier). src/worker/escalation.ts.
   */
  | "escalated:correction"
  | "escalated:test_failure"
  | "escalated:reverted_edit"
  /**
   * REFLEX_AB: the backend wanted this turn below the requested tier and the randomisation held it on the requested
   * model instead, as the control arm of the experiment. Not a refusal and not a failure.
   */
  | "ab_control";

/** Why a turn's effort target is what it is (REFLEX_EFFORT); recorded in the decision's `effort` block. */
export type EffortReason =
  | "effort_down"
  | "effort_up"
  | "effort_same"
  /** The backend's level is above the client's and REFLEX_EFFORT_UP is off: the client's level is kept. */
  | "effort_up_disabled"
  /** The client sent no effort (or one reflex does not know), so there is nothing to move from. */
  | "effort_requested_unknown"
  /** REFLEX_ESCALATE=1: the conversation's previous routed or effort-lowered turn closed with an outcome signal, so this turn does not go below the client's level. */
  | "effort_escalated"
  /** REFLEX_EFFORT_AB: held at the client's level at random, as the control arm. */
  | "effort_ab_control"
  /** The level could only be applied by inserting a message (a later main-chat turn) and REFLEX_EFFORT_MIDTURN is off. */
  | "effort_midturn_off";

export interface RoutePlan {
  /** Where the request would go; null = leave it on the requested model. */
  readonly target: Target | null;
  readonly reasons: readonly ReasonCode[];
  readonly wouldUpgrade: boolean;
}
