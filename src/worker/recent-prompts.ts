// The prompts UserPromptSubmit delivered, per session, held in the worker's memory only (never written or sent). Used to
// keep the user's own words out of side-call fingerprints (src/wire/fingerprint.ts), to rule a plain-string message in
// as a typed prompt (src/wire/claude-code.ts) and, as a count only, to cross-check the classifier (src/wire/drift.ts).
import { isTypedPrompt } from "../wire/claude-code.js";

/** Prompts kept per session; older ones are dropped. */
export const RECENT_PROMPTS_PER_SESSION = 50;
/** Sessions kept; the least recently used is dropped. */
const MAX_SESSIONS = 32;

interface Entry {
  readonly prompts: string[];
  /** Every typed prompt ever seen for the session, including ones dropped from `prompts`. A count, never the text. */
  typed: number;
}

export class RecentPrompts {
  readonly #bySession = new Map<string, Entry>();

  add(sessionId: string, prompt: string): void {
    const e = this.#bySession.get(sessionId) ?? { prompts: [], typed: 0 };
    this.#bySession.delete(sessionId);
    e.prompts.push(prompt);
    if (e.prompts.length > RECENT_PROMPTS_PER_SESSION) e.prompts.shift();
    if (isTypedPrompt(prompt)) e.typed++;
    this.#bySession.set(sessionId, e);
    if (this.#bySession.size > MAX_SESSIONS) this.#bySession.delete(this.#bySession.keys().next().value!);
  }

  /** null: no prompt has arrived for this session (hooks not delivered, or not yet). */
  get(sessionId: string | null): readonly string[] | null {
    return sessionId === null ? null : (this.#bySession.get(sessionId)?.prompts ?? null);
  }

  /** How many prompts the user typed in this session (injected messages, hand-backs and slash commands excluded). */
  typedCount(sessionId: string | null): number {
    return sessionId === null ? 0 : (this.#bySession.get(sessionId)?.typed ?? 0);
  }
}
