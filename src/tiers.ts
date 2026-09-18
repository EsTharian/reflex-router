import { TIERS, type Tier } from "./config.js";

/** Cheapest first. */
export const tierRank = (t: Tier): number => TIERS.indexOf(t);

/** Tier of a model id by family name (claude-sonnet-5, claude-haiku-4-5-20251001, claude-opus-5[1m], ...); null if unknown. */
export function tierOfModel(model: string | null): Tier | null {
  if (model === null) return null;
  const m = model.toLowerCase();
  return TIERS.find((t) => m.includes(t)) ?? null;
}
