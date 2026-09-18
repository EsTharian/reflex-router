import type { Tier } from "./config.js";

/**
 * Manual override: `!opus`, `!sonnet` or `!haiku` as a leading token of the user's own main-chat message (the text
 * reflex judges, harness wrappers already removed). The token stays in the text the model sees; reflex never edits
 * prompt text. Returns null when there is none. Pure.
 */
export function parseOverride(text: string | null): Tier | null {
  const m = /^\s*!(opus|sonnet|haiku)\b/i.exec(text ?? "");
  return m ? (m[1]!.toLowerCase() as Tier) : null;
}
