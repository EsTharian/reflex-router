// List prices used by the main-chat cost guard and (later) cost estimates in reports.
//
// CHECK AGAINST https://platform.claude.com/docs/en/about-claude/pricing BEFORE EVERY RELEASE and update LAST_VERIFIED.
// Not modelled: the 1.1x inference_geo "us" multiplier, batch and fast-mode pricing, negotiated discounts, and
// subscription plans (whose limits are not priced per token at all).
import type { Tier } from "./config.js";

export const LAST_VERIFIED = "2026-09-19";

export interface TierPrice {
  /** $ per million base input tokens. */
  readonly input: number;
  /** $ per million output tokens. */
  readonly output: number;
  /** Cache read ("hits and refreshes") as a multiple of base input. */
  readonly cacheReadMult: number;
}

/** Claude Haiku 4.5, Sonnet 5, Opus 5, Fable 5.1 (the tier defaults in config.ts). */
export const PRICES: Readonly<Record<Tier, TierPrice>> = {
  haiku: { input: 1, output: 5, cacheReadMult: 0.1 },
  sonnet: { input: 2, output: 10, cacheReadMult: 0.1 },
  opus: { input: 5, output: 25, cacheReadMult: 0.1 },
  fable: { input: 10, output: 50, cacheReadMult: 0.025 },
};

/** Cache write multiples of base input, by time-to-live. */
export const CACHE_WRITE_MULT = { "5m": 1.25, "1h": 2 } as const;
export type CacheTtl = keyof typeof CACHE_WRITE_MULT;

const perToken = (usdPerMTok: number): number => usdPerMTok / 1_000_000;

/** $ to write `tokens` into the cache of `tier`. */
export const cacheWriteUsd = (tier: Tier, tokens: number, ttl: CacheTtl): number => tokens * perToken(PRICES[tier].input) * CACHE_WRITE_MULT[ttl];

/** $ to read `tokens` from the cache of `tier`. */
export const cacheReadUsd = (tier: Tier, tokens: number): number => tokens * perToken(PRICES[tier].input) * PRICES[tier].cacheReadMult;

/** Token counts of one response, as `usage` in the decision log. */
export interface UsageTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
}

/** $ list-price estimate of one response's usage on `tier` (used by `reflex report`; an estimate, see the caveats at the top of this file). */
export const usageCostUsd = (tier: Tier, u: UsageTokens, ttl: CacheTtl): number => {
  const p = PRICES[tier];
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.input * p.cacheReadMult + u.cacheCreate * p.input * CACHE_WRITE_MULT[ttl]) / 1_000_000;
};
