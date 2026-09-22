// Tells the user in the chat when reflex moves the main chat to a different model. The notice rides on the next main-chat
// hook answer as `systemMessage`, which Claude Code shows to the user and does not send to the model. Only the model
// name changes hands; the notice can never block, change a prompt or reach the model. State is in memory only.
import type { DecisionInfo } from "../outcome/tracker.js";
import { tierOfModel, tierRank } from "../tiers.js";

export class ModelNotices {
  /** Per session: the model the client asked for and the one reflex sent, on the last main-chat request. */
  readonly #last = new Map<string, { requested: string | null; sent: string }>();
  /** Per session: the model the user last saw, while a change is waiting for a hook to carry it. */
  readonly #pending = new Map<string, string>();

  observe(d: DecisionInfo): void {
    if (d.kind !== "main" || d.turn === "side" || d.agentId !== null || d.sessionId === null || d.sentModel === null) return;
    const last = this.#last.get(d.sessionId);
    this.#last.set(d.sessionId, { requested: d.requestedModel, sent: d.sentModel });
    // The user switching models (/model) is their own change, not news: start again from what they asked for.
    if (last !== undefined && last.requested !== d.requestedModel) this.#pending.delete(d.sessionId);
    const shown = last !== undefined && last.requested === d.requestedModel ? last.sent : d.requestedModel;
    if (shown === null || shown === d.sentModel) return;
    // Several changes before the next hook collapse into one notice from the first model to the latest.
    const from = this.#pending.get(d.sessionId) ?? shown;
    if (from === d.sentModel) this.#pending.delete(d.sessionId);
    else this.#pending.set(d.sessionId, from);
  }

  /** The pending notice for this session, once. */
  take(sessionId: string): string | null {
    const from = this.#pending.get(sessionId);
    const to = this.#last.get(sessionId)?.sent;
    this.#pending.delete(sessionId);
    return from === undefined || to === undefined ? null : notice(from, to);
  }
}

export function notice(from: string, to: string): string {
  const a = tierOfModel(from);
  const b = tierOfModel(to);
  const verb = a === null || b === null || a === b ? "switched" : tierRank(b) < tierRank(a) ? "downgraded" : "upgraded";
  return `reflex ${verb} the model: ${from} → ${to}`;
}
