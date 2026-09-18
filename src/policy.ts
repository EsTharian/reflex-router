// ALL routing policy: the questions asked, how answers become a Judgement, and how a Judgement becomes a RoutePlan.
// Pure (no I/O). Organised as tables so a new dimension (effort) is new rows, not a restructure. Every threshold is a
// provisional constant, logged with the raw answers so shadow data can retune it.
import type { Config, Tier } from "./config.js";
import { tierRank, tierOfModel } from "./tiers.js";
import type { Answer, Decision, Dimension, Judgement, Picked, QuestionSet, ReasonCode, RoutePlan, Target } from "./types.js";

/** A downgrade needs at least this choice confidence (a spread statistic, not the top probability). */
export const DOWNGRADE_MIN_CONFIDENCE = 0.7;
/** Upgrades under REFLEX_UPGRADES=confident need at least this. */
export const UPGRADE_MIN_CONFIDENCE = 0.7;
/** Composite veto: the highest reasoning_demand score (0..4) that still allows a downgrade TO this tier. */
export const MAX_REASONING_DEMAND_FOR: Readonly<Partial<Record<Tier, number>>> = { haiku: 1.0, sonnet: 2.5 };

const STATE_GUIDE =
  "`task` is the work to be done. `previous_assistant_reply`, when present, is the end of the assistant's previous message, for context only. " +
  "`context.is_subagent` says whether another agent delegated this task; `context.requesting_tier` is the tier the client asked for.";

const TIER_OPTIONS: Readonly<Record<Tier, { what: string; not_for: string; examples: readonly string[] }>> = {
  haiku: {
    what: "Mechanical or tightly specified work where the approach is obvious and a mistake is easy to spot.",
    not_for: "Anything that needs a diagnosis, a design choice, or understanding how several parts interact.",
    examples: ["list the files in a directory", "rename a variable across one file", "run the tests and report the result", "find where a function is defined"],
  },
  sonnet: {
    what: "Ordinary software work: a well-understood change or investigation that takes some judgement about the approach.",
    not_for: "Problems whose cause is unknown across systems, or decisions where a subtle mistake is costly.",
    examples: ["add a flag to a CLI command and its tests", "fix a failing test with a clear error message", "summarise how a module works"],
  },
  opus: {
    what: "Hard reasoning: unknown-cause debugging, cross-module design, security-sensitive or subtle correctness work.",
    not_for: "Routine changes whose approach is already clear.",
    examples: ["find why a race condition corrupts data intermittently", "design the module boundaries for a new subsystem", "review an auth flow for vulnerabilities"],
  },
  fable: {
    what: "The most demanding open-ended research and reasoning, beyond what opus handles well.",
    not_for: "Any task opus can do well.",
    examples: ["invent and prove a new algorithm for an open problem"],
  },
};

const REASONING_LEVELS = [
  { what: "Mechanical: rename, reformat, run one command, look something up, list files." },
  { what: "Routine: a small, well-specified change or search with an obvious approach." },
  { what: "Moderate: a multi-step change within one area that needs some judgement about the approach." },
  { what: "Hard: debugging with an unclear cause, a change spanning several modules, or non-trivial design choices." },
  { what: "Open-ended: unknown-cause debugging across systems, architecture decisions, security-sensitive changes, novel algorithms." },
] as const;

/** Tiers offered to the backend: Fable only when explicitly allowed. */
export const offeredTiers = (cfg: Pick<Config, "allowFable">): Tier[] => (cfg.allowFable ? ["haiku", "sonnet", "opus", "fable"] : ["haiku", "sonnet", "opus"]);

type Part = Partial<Pick<Judgement, "tier">> & { vetoes?: Record<string, number> };

interface QuestionSpec {
  build(cfg: Config): QuestionSet[string];
  /** Reads this question's answer into part of a Judgement; returns an error string for a malformed answer. */
  read(a: Answer, cfg: Config): Part | string;
}

/** 1. Questions, all asked in one backend call. */
export const QUESTIONS: Readonly<Record<string, QuestionSpec>> = {
  tier: {
    build: (cfg) => ({
      type: "choice",
      instructions: {
        question: "Which is the least capable Claude model tier that will still do this task well?",
        focus:
          "Judge the reasoning the task demands: ambiguity, how many interacting parts must be understood at once, and how costly a subtle mistake would be. " +
          "The length of the message, the length of the expected reply and the number of files mentioned are NOT the measure.",
        state: STATE_GUIDE,
      },
      criteria: Object.fromEntries(offeredTiers(cfg).map((t) => [t, TIER_OPTIONS[t]])),
    }),
    read: (a, cfg) => {
      if (a.type !== "choice") return "tier: not a choice answer";
      const offered = offeredTiers(cfg) as string[];
      if (!offered.includes(a.choice)) return "tier: choice is not an offered tier";
      const tier: Picked<Tier> = { value: a.choice as Tier, confidence: a.confidence, probabilities: a.probabilities };
      return { tier };
    },
  },
  reasoning_demand: {
    build: () => ({
      type: "score",
      instructions: { question: "How much reasoning does this task demand?", focus: "Judge the thinking required, not the amount of text or the number of steps.", state: STATE_GUIDE },
      criteria: REASONING_LEVELS,
    }),
    read: (a) => (a.type === "score" ? { vetoes: { reasoning_demand: a.score } } : "reasoning_demand: not a score answer"),
  },
};

export const buildQuestions = (cfg: Config): QuestionSet => Object.fromEntries(Object.entries(QUESTIONS).map(([id, q]) => [id, q.build(cfg)]));

/** 3a. Merges every question's reading. A missing or malformed answer is an error (the caller fails open). */
export function judge(decision: Decision, cfg: Config): { ok: true; judgement: Judgement } | { ok: false; error: string } {
  let tier: Picked<Tier> | undefined;
  const vetoes: Record<string, number> = {};
  for (const [id, spec] of Object.entries(QUESTIONS)) {
    const a = decision.answers[id];
    if (!a) return { ok: false, error: `${id}: missing answer` };
    const part = spec.read(a, cfg);
    if (typeof part === "string") return { ok: false, error: part };
    if (part.tier) tier = part.tier;
    Object.assign(vetoes, part.vetoes ?? {});
  }
  if (!tier) return { ok: false, error: "no tier answer" };
  return { ok: true, judgement: { tier, vetoes } };
}

/** What the plan needs to know about the request (no body access). */
export interface PlanInput {
  readonly kind: "main" | "subagent";
  readonly requestedModel: string | null;
}

interface DimensionRules {
  apply(input: PlanInput, j: Judgement, cfg: Config): { target: Partial<Target> | null; reasons: ReasonCode[]; wouldUpgrade: boolean };
}

/** Lowest enabled tier at or above `from` (and below `below`, when given). Never steps down. */
function clampUp(from: Tier, cfg: Config, below?: Tier): Tier | null {
  return cfg.tiers.find((t) => tierRank(t) >= tierRank(from) && (below === undefined || tierRank(t) < tierRank(below))) ?? null;
}

/** 2. Per-dimension rules. Phase 1 populates only "tier". */
export const DIMENSIONS: Readonly<Partial<Record<Dimension, DimensionRules>>> = {
  tier: {
    apply(input, j, cfg) {
      const requested = tierOfModel(input.requestedModel);
      if (requested === null) return { target: null, reasons: ["requested_tier_unknown"], wouldUpgrade: false };
      const chosen = j.tier.value;
      if (chosen === requested) return { target: null, reasons: ["same_tier"], wouldUpgrade: false };

      if (tierRank(chosen) < tierRank(requested)) {
        if (j.tier.confidence < DOWNGRADE_MIN_CONFIDENCE) return { target: null, reasons: ["low_confidence"], wouldUpgrade: false };
        const limit = MAX_REASONING_DEMAND_FOR[chosen];
        const demand = j.vetoes["reasoning_demand"];
        if (limit !== undefined && (demand === undefined || demand > limit)) return { target: null, reasons: ["veto_reasoning_demand"], wouldUpgrade: false };
        const to = clampUp(chosen, cfg, requested);
        if (to === null) return { target: null, reasons: ["no_enabled_tier"], wouldUpgrade: false };
        return { target: { tier: to }, reasons: to === chosen ? ["downgrade"] : ["downgrade", "clamped_up"], wouldUpgrade: false };
      }

      // The backend wants a stronger tier than the client asked for.
      if (cfg.upgrades === "off") return { target: null, reasons: ["upgrade_disabled"], wouldUpgrade: true };
      if (cfg.upgrades === "confident" && j.tier.confidence < UPGRADE_MIN_CONFIDENCE) return { target: null, reasons: ["upgrade_low_confidence"], wouldUpgrade: true };
      const to = clampUp(chosen, cfg);
      if (to === null) return { target: null, reasons: ["no_enabled_tier"], wouldUpgrade: true };
      return { target: { tier: to }, reasons: to === chosen ? ["upgrade"] : ["upgrade", "clamped_up"], wouldUpgrade: true };
    },
  },
};

/**
 * 3b. Pure. The plan for one `new` turn: main-chat scope first, then every populated dimension. The main-chat cost
 * guard, disabled tiers and rewrite verification are applied afterwards by the router (they need session state).
 */
export function plan(input: PlanInput, j: Judgement, cfg: Config): RoutePlan {
  if (input.kind === "main" && cfg.mainChat === "never") return { target: null, reasons: ["main_chat_disabled"], wouldUpgrade: false };
  const tier = DIMENSIONS.tier?.apply(input, j, cfg);
  if (!tier) return { target: null, reasons: [], wouldUpgrade: false };
  const target: Target | null = tier.target?.tier ? { tier: tier.target.tier } : null;
  return { target, reasons: tier.reasons, wouldUpgrade: tier.wouldUpgrade };
}
