// Tells the user in the chat when reflex moves the main chat to a different model. The notice rides on the next main-chat
// hook answer as `systemMessage`, which Claude Code shows to the user and does not send to the model. Only the model
// name changes hands; the notice can never block, change a prompt or reach the model. State is in memory only.
import type { DecisionInfo } from "../outcome/tracker.js";
import { tierOfModel, tierRank } from "../tiers.js";

export class ModelNotices {
  /** Per session: the model the client asked for and the one reflex sent, on the last main-chat request. */
  readonly #last = new Map<string, { requested: string | null; sent: string }>();
  /** Per session: changes waiting for a hook to carry them, oldest first. */
  readonly #pending = new Map<string, { from: string; to: string }[]>();

  observe(d: DecisionInfo): void {
    if (d.kind !== "main" || d.turn === "side" || d.agentId !== null || d.sessionId === null || d.sentModel === null) return;
    const last = this.#last.get(d.sessionId);
    this.#last.set(d.sessionId, { requested: d.requestedModel, sent: d.sentModel });
    // The user switching models (/model) is their own change, not news: start again from what they asked for. A
    // change reflex made before it is still news and stays queued (a hook may not have fired in between).
    const shown = last !== undefined && last.requested === d.requestedModel ? last.sent : d.requestedModel;
    if (shown === null || shown === d.sentModel) return;
    const list = this.#pending.get(d.sessionId) ?? [];
    const tail = list.at(-1);
    // Several changes before the next hook collapse into one notice from the first model to the latest.
    if (tail !== undefined && tail.to === shown) {
      if (tail.from === d.sentModel) list.pop();
      else tail.to = d.sentModel;
    } else list.push({ from: shown, to: d.sentModel });
    if (list.length > 0) this.#pending.set(d.sessionId, list);
    else this.#pending.delete(d.sessionId);
  }

  /** The pending notice for this session, once. */
  take(sessionId: string): string | null {
    const list = this.#pending.get(sessionId);
    this.#pending.delete(sessionId);
    return list === undefined ? null : list.map((c) => notice(c.from, c.to)).join("\n");
  }
}

export function notice(from: string, to: string): string {
  const a = tierOfModel(from);
  const b = tierOfModel(to);
  const verb = a === null || b === null || a === b ? "switched" : tierRank(b) < tierRank(a) ? "downgraded" : "upgraded";
  return `reflex ${verb} the model: ${from} → ${to}`;
}
