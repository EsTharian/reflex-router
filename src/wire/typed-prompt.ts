// Whether a piece of request text is (the start of) a prompt the user typed in this session.
//
// Shared on purpose. Two callers ask this question and must never disagree about the same text: the classifier, which
// treats a typed message riding along with tool results as the user interjecting into their own turn
// (src/wire/claude-code.ts), and the fingerprint, which drops a head that overlaps a typed prompt so no user text is
// ever written to disk (src/wire/fingerprint.ts). If one said "harness text" while the other said "the user's words",
// a side call could be labelled and a fingerprint kept for the very same sentence.
//
// The prompts come from UserPromptSubmit payloads held in the worker's memory only (src/worker/recent-prompts.ts).
// Neither caller keeps any of them, and nothing here returns any part of the text it was given.
import { head } from "../privacy/budget.js";

/** Code points of the text compared against a typed prompt's start. */
export const TYPED_PROMPT_LEAD_MAX = 80;
/** Code points of a typed prompt's start looked for inside the text, when the harness wrapped the user's words. */
const TYPED_PROMPT_NEEDLE = 40;
/** A typed prompt shorter than this is too weak to match on: it would hit unrelated text. */
const TYPED_PROMPT_MIN = 4;

const norm = (t: string): string => t.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * True when `text` is (the start of) one of `typed`, or contains the start of one — the shape the harness produces
 * when it wraps the user's own words in a template.
 *
 * `typed` null means no UserPromptSubmit has been seen in this session, so nothing can be ruled in: never a match.
 * Each caller decides what that absence means for it (the fingerprint drops the head; the classifier does not claim an
 * interjection). Empty or whitespace-only text is never a match.
 */
export function matchesTypedPrompt(text: string, typed: readonly string[] | null): boolean {
  if (typed === null) return false;
  const t = norm(text);
  if (t === "") return false;
  const lead = norm(head(text, TYPED_PROMPT_LEAD_MAX));
  if (lead === "") return false;
  return typed.some((p) => {
    const q = norm(p);
    return q !== "" && (q.includes(lead) || (q.length >= TYPED_PROMPT_MIN && t.includes(q.slice(0, TYPED_PROMPT_NEEDLE))));
  });
}
