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
  /**
   * The newest typed prompt whose own request has not yet been recognised on the wire, or null when the newest has
   * already been claimed. Only this one can turn a plain-string message into a `new` turn: a side call that replays
   * history can only carry an OLDER prompt, so it can never match and stays `side` (src/wire/claude-code.ts).
   */
  unclaimed: string | null;
}

export class RecentPrompts {
  readonly #bySession = new Map<string, Entry>();

  add(sessionId: string, prompt: string): void {
    const e = this.#bySession.get(sessionId) ?? { prompts: [], typed: 0, unclaimed: null };
    this.#bySession.delete(sessionId);
    e.prompts.push(prompt);
    if (e.prompts.length > RECENT_PROMPTS_PER_SESSION) e.prompts.shift();
    if (isTypedPrompt(prompt)) {
      e.typed++;
      e.unclaimed = prompt; // a newer prompt supersedes an unclaimed older one: only the newest can open a turn
    }
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

  /** The newest typed prompt not yet claimed by a wire turn; null when there is none or it has been claimed. */
  newestUnclaimed(sessionId: string | null): string | null {
    return sessionId === null ? null : (this.#bySession.get(sessionId)?.unclaimed ?? null);
  }

  /** A main `new` turn was recognised: whatever encoding it used, it consumed the newest typed prompt. */
  claimNewest(sessionId: string | null): void {
    if (sessionId === null) return;
    const e = this.#bySession.get(sessionId);
    if (e) e.unclaimed = null;
  }
}
