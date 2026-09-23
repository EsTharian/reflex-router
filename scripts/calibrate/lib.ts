// Pure fitting code for the Laya calibration head (src/backend/laya-calibration.ts): soft-target multinomial logistic
// regression for the tier (distillation of Jev's tier distribution), ridge regression for the reasoning score, and a
// grouped k-fold cross-validation that reports what the policy would do with the result. No dependencies.
import { CAL_TIERS, softmax, type LayaCalibration } from "../../src/backend/laya-calibration.js";
import type { Tier } from "../../src/config.js";
import { massPick, MAX_REASONING_DEMAND_FOR } from "../../src/policy.js";
import { tierRank } from "../../src/tiers.js";
import type { Answer } from "../../src/types.js";

/** Jev's view of one state: its tier distribution over CAL_TIERS (renormalised) and its reasoning score. */
export interface Target {
  readonly p: Readonly<Record<string, number>>;
  readonly demand: number;
}

export interface Sample {
  readonly x: readonly number[];
  readonly t: Target;
  /** Samples in one group are correlated (one session); cross-validation never splits a group. */
  readonly group: string;
  /** Real traffic (typed prompts or recorded sessions), not a synthetic corpus: the safety margin is tuned on these. */
  readonly real?: boolean;
}

/** Adds `delta` to the opus logit: every plan leans that much towards keeping the dearer tier. */
export function withOpusMargin(p: Readonly<Record<string, number>>, delta: number): Record<string, number> {
  const opus = (p["opus"] ?? 0) * Math.exp(delta);
  const s = (p["haiku"] ?? 0) + (p["sonnet"] ?? 0) + opus;
  return { haiku: (p["haiku"] ?? 0) / s, sonnet: (p["sonnet"] ?? 0) / s, opus: opus / s };
}

export function jevTarget(answers: Readonly<Record<string, Answer>>): Target | null {
  const tier = answers["tier"];
  const demand = answers["reasoning_demand"];
  if (tier?.type !== "choice" || demand?.type !== "score") return null;
  return targetOf(tier.probabilities, demand.score);
}

export function targetOf(probabilities: Readonly<Record<string, number>>, demand: number): Target | null {
  const s = CAL_TIERS.reduce((a, t) => a + (probabilities[t] ?? 0), 0);
  if (!(s > 0)) return null;
  return { p: Object.fromEntries(CAL_TIERS.map((t) => [t, (probabilities[t] ?? 0) / s])), demand };
}

/** Column means and standard deviations, the bias (last column) left at 0 / 1. */
function standardiser(xs: readonly (readonly number[])[]): { mu: number[]; sd: number[] } {
  const d = xs[0]!.length;
  const mu = Array.from({ length: d }, (_, j) => (j === d - 1 ? 0 : xs.reduce((a, x) => a + x[j]!, 0) / xs.length));
  const sd = Array.from({ length: d }, (_, j) => {
    if (j === d - 1) return 1;
    const v = xs.reduce((a, x) => a + (x[j]! - mu[j]!) ** 2, 0) / xs.length;
    return v > 1e-12 ? Math.sqrt(v) : 1;
  });
  return { mu, sd };
}

/** Weights fitted on standardised features, rewritten to apply to raw features. */
function unstandardise(w: readonly number[], mu: readonly number[], sd: readonly number[]): number[] {
  const d = w.length;
  const raw = w.map((wj, j) => (j === d - 1 ? wj : wj / sd[j]!));
  raw[d - 1] = w[d - 1]! - w.slice(0, d - 1).reduce((a, wj, j) => a + (wj * mu[j]!) / sd[j]!, 0);
  return raw;
}

/** Soft-target multinomial logistic regression, L2 on everything but the bias, full-batch Adam. */
export function fitTier(samples: readonly Sample[], lambda: number, iterations = 3000): number[][] {
  const { mu, sd } = standardiser(samples.map((s) => s.x));
  const z = samples.map((s) => s.x.map((v, j) => (v - mu[j]!) / sd[j]!));
  const K = CAL_TIERS.length;
  const d = z[0]!.length;
  const W = Array.from({ length: K }, () => new Array<number>(d).fill(0));
  const m = W.map((r) => r.map(() => 0));
  const v = W.map((r) => r.map(() => 0));
  const lr = 0.05, b1 = 0.9, b2 = 0.999;
  for (let it = 1; it <= iterations; it++) {
    const g = W.map((r) => r.map(() => 0));
    for (const [n, zn] of z.entries()) {
      const p = softmax(W.map((w) => w.reduce((a, wj, j) => a + wj * zn[j]!, 0)));
      for (let k = 0; k < K; k++) {
        const diff = p[k]! - samples[n]!.t.p[CAL_TIERS[k]!]!;
        for (let j = 0; j < d; j++) g[k]![j]! += (diff * zn[j]!) / z.length;
      }
    }
    for (let k = 0; k < K; k++)
      for (let j = 0; j < d; j++) {
        const gj = g[k]![j]! + (j === d - 1 ? 0 : lambda * W[k]![j]!);
        m[k]![j] = b1 * m[k]![j]! + (1 - b1) * gj;
        v[k]![j] = b2 * v[k]![j]! + (1 - b2) * gj * gj;
        W[k]![j]! -= (lr * (m[k]![j]! / (1 - b1 ** it))) / (Math.sqrt(v[k]![j]! / (1 - b2 ** it)) + 1e-8);
      }
  }
  return W.map((w) => unstandardise(w, mu, sd));
}

/** Solves A w = b (A square, positive definite here) by Gaussian elimination with partial pivoting. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  const w = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) w[r] = (M[r]![n]! - M[r]!.slice(r + 1, n).reduce((a, v, k) => a + v * w[r + 1 + k]!, 0)) / M[r]![r]!;
  return w;
}

/** Ridge regression of Jev's reasoning score on the features (bias unpenalised). */
export function fitDemand(samples: readonly Sample[], lambda: number): number[] {
  const { mu, sd } = standardiser(samples.map((s) => s.x));
  const z = samples.map((s) => s.x.map((v, j) => (v - mu[j]!) / sd[j]!));
  const d = z[0]!.length;
  const A = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => z.reduce((a, zn) => a + zn[i]! * zn[j]!, 0) + (i === j && i !== d - 1 ? lambda * z.length : 0)));
  const b = Array.from({ length: d }, (_, i) => z.reduce((a, zn, n) => a + zn[i]! * samples[n]!.t.demand, 0));
  return unstandardise(solve(A, b), mu, sd);
}

const pickOf = (p: Readonly<Record<string, number>>, eps: number): Tier => massPick(p, CAL_TIERS, eps).value;

/** What the policy does with Opus requested: the mass pick, unless the reasoning-demand veto keeps the request on Opus. */
export function planned(p: Readonly<Record<string, number>>, demand: number, eps: number): Tier {
  const pick = pickOf(p, eps);
  const limit = MAX_REASONING_DEMAND_FOR[pick];
  return limit !== undefined && demand > limit ? "opus" : pick;
}

export interface Scores {
  n: number;
  /** Mass pick equal to Jev's mass pick. */
  agree: number;
  /** Cheaper than Jev's pick: the direction that can cost quality. */
  under: number;
  over: number;
  /** The same three counts for the tier the policy would plan with Opus requested (veto applied): what a user gets. */
  plan: { agree: number; under: number; over: number; picks: Record<string, number> };
  /** Per Jev planned tier: how many of those turns got exactly that tier here (recall). */
  recall: Record<string, string>;
  /** Mean cross-entropy against Jev's distribution. */
  xent: number;
  demandMae: number;
  picks: Record<string, number>;
}

export function score(pairs: readonly { p: Readonly<Record<string, number>>; demand: number; t: Target }[], eps: number): Scores {
  const s: Scores = { n: pairs.length, agree: 0, under: 0, over: 0, plan: { agree: 0, under: 0, over: 0, picks: { haiku: 0, sonnet: 0, opus: 0 } }, recall: {}, xent: 0, demandMae: 0, picks: { haiku: 0, sonnet: 0, opus: 0 } };
  const hit: Record<string, [number, number]> = { haiku: [0, 0], sonnet: [0, 0], opus: [0, 0] };
  for (const { p, demand, t } of pairs) {
    const mineP = planned(p, demand, eps);
    const jevP = planned(t.p, t.demand, eps);
    s.plan.picks[mineP]! += 1;
    hit[jevP]![1] += 1;
    if (mineP === jevP) hit[jevP]![0] += 1;
    if (mineP === jevP) s.plan.agree++;
    else if (tierRank(mineP) < tierRank(jevP)) s.plan.under++;
    else s.plan.over++;
    const mine = pickOf(p, eps);
    const jev = pickOf(t.p, eps);
    s.picks[mine]! += 1;
    if (mine === jev) s.agree++;
    else if (tierRank(mine) < tierRank(jev)) s.under++;
    else s.over++;
    s.xent -= CAL_TIERS.reduce((a, k) => a + (t.p[k] ?? 0) * Math.log(Math.max(1e-9, p[k] ?? 0)), 0) / pairs.length;
    s.demandMae += Math.abs(demand - t.demand) / pairs.length;
  }
  s.recall = Object.fromEntries(Object.entries(hit).map(([k, [a, n]]) => [k, `${a}/${n}`]));
  return s;
}

const dot = (w: readonly number[], x: readonly number[]): number => w.reduce((a, wj, j) => a + wj * x[j]!, 0);

export function predict(tierWeights: readonly (readonly number[])[], demandWeights: readonly number[], x: readonly number[]): { p: Record<string, number>; demand: number } {
  const p = softmax(tierWeights.map((w) => dot(w, x)));
  return { p: Object.fromEntries(CAL_TIERS.map((t, i) => [t, p[i]!])), demand: Math.min(4, Math.max(0, dot(demandWeights, x))) };
}

/** Laya's uncalibrated reading of the same features: its own tier probabilities (x[0..2] are their logs). */
export const rawOf = (x: readonly number[]): { p: Record<string, number>; demand: number } => {
  const e = CAL_TIERS.map((_, i) => Math.exp(x[i]!));
  const s = e.reduce((a, b) => a + b, 0);
  return { p: Object.fromEntries(CAL_TIERS.map((t, i) => [t, e[i]! / s])), demand: x[3]! * 4 };
};

/** Grouped k-fold: every sample of a group lands in the same fold. Returns out-of-fold predictions in sample order. */
export function crossValidate(samples: readonly Sample[], lambda: number, folds = 5): { p: Record<string, number>; demand: number }[] {
  const groups = [...new Set(samples.map((s) => s.group))];
  const foldOf = new Map(groups.map((g, i) => [g, i % folds]));
  const out = new Array<{ p: Record<string, number>; demand: number }>(samples.length);
  for (let f = 0; f < folds; f++) {
    const train = samples.filter((s) => foldOf.get(s.group) !== f);
    const test = samples.map((s, i) => [s, i] as const).filter(([s]) => foldOf.get(s.group) === f);
    if (test.length === 0 || train.length === 0) continue;
    const W = fitTier(train, lambda);
    const dw = fitDemand(train, lambda);
    for (const [s, i] of test) out[i] = predict(W, dw, s.x);
  }
  return out;
}

/** The fitted head; `opusMargin` is folded into the opus row's bias (withOpusMargin, in weight form). */
export function calibrationOf(version: string, featureVersion: string, samples: readonly Sample[], lambda: number, fit: Record<string, number | string>, opusMargin = 0): LayaCalibration {
  const round = (w: readonly number[]): number[] => w.map((v) => Math.round(v * 1e6) / 1e6);
  const tier = fitTier(samples, lambda);
  const opus = tier[CAL_TIERS.indexOf("opus")]!;
  opus[opus.length - 1]! += opusMargin;
  return { version, featureVersion, tierWeights: tier.map(round), demandWeights: round(fitDemand(samples, lambda)), fit };
}
