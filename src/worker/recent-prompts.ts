// The prompts UserPromptSubmit delivered, per session, held in the worker's memory only (never written or sent). Used to
// keep the user's own words out of side-call fingerprints (src/wire/fingerprint.ts).

/** Prompts kept per session; older ones are dropped. */
export const RECENT_PROMPTS_PER_SESSION = 50;
/** Sessions kept; the least recently used is dropped. */
const MAX_SESSIONS = 32;

export class RecentPrompts {
  readonly #bySession = new Map<string, string[]>();

  add(sessionId: string, prompt: string): void {
    const list = this.#bySession.get(sessionId) ?? [];
    this.#bySession.delete(sessionId);
    list.push(prompt);
    if (list.length > RECENT_PROMPTS_PER_SESSION) list.shift();
    this.#bySession.set(sessionId, list);
    if (this.#bySession.size > MAX_SESSIONS) this.#bySession.delete(this.#bySession.keys().next().value!);
  }

  /** null: no prompt has arrived for this session (hooks not delivered, or not yet). */
  get(sessionId: string | null): readonly string[] | null {
    return sessionId === null ? null : (this.#bySession.get(sessionId) ?? null);
  }
}
