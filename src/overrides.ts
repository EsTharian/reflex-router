import type { Tier } from "./config.js";

/**
 * Manual override: `reflex:opus`, `reflex:sonnet` or `reflex:haiku` at the start of the user's own main-chat text
 * (the text reflex judges: harness reminders removed, <pasted_content> wrappers unwrapped). Not `!`/`/`/`@`/`#`:
 * Claude Code consumes those (`!` is bash mode), so such a token would never reach the API. The token stays in the
 * text the model sees; reflex never edits prompt text. Returns null when there is none. Pure.
 */
export function parseOverride(text: string | null): Tier | null {
  const m = /^\s*reflex:(opus|sonnet|haiku)\b/i.exec(text ?? "");
  return m ? (m[1]!.toLowerCase() as Tier) : null;
}
