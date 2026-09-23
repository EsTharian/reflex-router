// Laya calibration: Laya's zero-shot answers to the product's questions sit in a narrow band that the policy never
// reads as a downgrade (docs/observations.md, 2026-09-23). A small learned head maps what Laya says - its answers to
// the product's own questions plus a few yes/no feature questions asked only of Laya - to a tier distribution and a
// reasoning score on Jev's scale. It was fitted by distillation: the same states were put to Jev and to Laya and the
// head learned to reproduce Jev's answers (scripts/calibrate/fit.ts). Parameters live in laya-calibration.generated.ts,
// so a user of Laya never needs Jev. Pure: no I/O.
import type { Tier } from "../config.js";
import type { Answer, DecisionState, QuestionSet } from "../types.js";

/** Bump when a feature question or the feature vector changes: fitted parameters are only valid for one version. */
export const FEATURE_VERSION = "lf-1";

/** Yes/no questions asked of Laya only, as extra evidence for the head. Order is part of FEATURE_VERSION. */
export const FEATURE_QUESTIONS: QuestionSet = {
  f_mechanical: { type: "noul", instructions: "Is this a mechanical task (rename, reformat, list, look something up, run one command, a trivial edit) whose approach is obvious?" },
  f_specified: { type: "noul", instructions: "Does the task state exactly what to change, so that no design choice is left to make?" },
  f_question: { type: "noul", instructions: "Is this a question that needs only a short factual answer, with nothing to change?" },
  f_unknown_cause: { type: "noul", instructions: "Does the task ask to find the cause of a bug or failure whose cause is not yet known?" },
  f_design: { type: "noul", instructions: "Does the task ask for a design, architecture or trade-off decision?" },
  f_multi_part: { type: "noul", instructions: "Must several interacting components or systems be understood together to do this task well?" },
  f_subtle: { type: "noul", instructions: "Is the task security-sensitive or about subtle correctness such as concurrency, data integrity or authentication?" },
};

/** The tiers the head is fitted over, cheapest first. Calibration applies only when exactly these are offered. */
export const CAL_TIERS: readonly Tier[] = ["haiku", "sonnet", "opus"];
const LEVELS = 5; // reasoning_demand is scored 0..4

export interface LayaCalibration {
  /** Identifies the fitted parameters in logs (`backend_version` gets `+<version>`). */
  readonly version: string;
  readonly featureVersion: string;
  /** One weight row per CAL_TIERS entry, over the feature vector (last weight is the bias). */
  readonly tierWeights: readonly (readonly number[])[];
  /** Linear map from the feature vector to Jev's 0..4 reasoning score (last weight is the bias). */
  readonly demandWeights: readonly number[];
  /** How the parameters were fitted (sample count, cross-validated agreement); documentation only. */
  readonly fit: Readonly<Record<string, number | string>>;
}

const clampP = (p: number): number => Math.min(1 - 1e-4, Math.max(1e-4, p));
const logit = (p: number): number => Math.log(clampP(p) / (1 - clampP(p)));

/**
 * The feature vector for one decision, or null when Laya's answers are incomplete. Layout (FEATURE_VERSION lf-1):
 * log P(tier) for haiku, sonnet, opus; the reasoning score / 4; logit P(yes) of each FEATURE_QUESTIONS entry; whether
 * the task was delegated by another agent; whether the previous assistant reply was sent; 1 (bias).
 */
export function layaFeatures(answers: Readonly<Record<string, Answer>>, state: Pick<DecisionState, "context" | "previous_assistant_reply">): number[] | null {
  const tier = answers["tier"];
  const demand = answers["reasoning_demand"];
  if (tier?.type !== "choice" || demand?.type !== "score") return null;
  const x = CAL_TIERS.map((t) => Math.log(clampP(tier.probabilities[t] ?? 0)));
  x.push(demand.score / (LEVELS - 1));
  for (const id of Object.keys(FEATURE_QUESTIONS)) {
    const a = answers[id];
    if (a?.type !== "noul") return null;
    x.push(logit(a.p));
  }
  x.push(state.context.is_subagent ? 1 : 0, state.previous_assistant_reply !== undefined ? 1 : 0, 1);
  return x;
}

const dot = (w: readonly number[], x: readonly number[]): number => w.reduce((s, wi, i) => s + wi * (x[i] ?? 0), 0);

export function softmax(z: readonly number[]): number[] {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

/** Calibrated tier probabilities (over CAL_TIERS) and reasoning score for one feature vector. */
export function applyCalibration(cal: LayaCalibration, x: readonly number[]): { probabilities: Record<Tier, number>; demand: number } {
  const p = softmax(cal.tierWeights.map((w) => dot(w, x)));
  const probabilities = Object.fromEntries(CAL_TIERS.map((t, i) => [t, p[i]!])) as Record<Tier, number>;
  const demand = Math.min(LEVELS - 1, Math.max(0, dot(cal.demandWeights, x)));
  return { probabilities, demand };
}

/**
 * The calibrated answers to the product's two questions, in the backend answer shape the policy reads. Confidence is
 * 1 - normalised entropy (a spread statistic, like the backend's own); the score's level probabilities are the nearest
 * two levels, linearly interpolated, so the answer stays a valid distribution.
 */
export function calibratedAnswers(cal: LayaCalibration, x: readonly number[]): { tier: Answer; reasoning_demand: Answer } {
  const { probabilities, demand } = applyCalibration(cal, x);
  const ps = CAL_TIERS.map((t) => probabilities[t]);
  const entropy = -ps.reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0);
  const choice = CAL_TIERS[ps.indexOf(Math.max(...ps))]!;
  const lo = Math.floor(demand);
  const levels = Object.fromEntries(Array.from({ length: LEVELS }, (_, i) => [String(i), i === lo ? 1 - (demand - lo) : i === lo + 1 ? demand - lo : 0]));
  return {
    tier: { type: "choice", choice, probabilities, confidence: 1 - entropy / Math.log(CAL_TIERS.length) },
    reasoning_demand: { type: "score", score: demand, probabilities: levels, confidence: 1 - Math.abs(demand - Math.round(demand)) },
  };
}
