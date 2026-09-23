// What `reflex statusline` shows: per session, the model the main chat asked for and the one reflex sent on its last
// request, and the same for each subagent. Model ids only, in memory only, served on loopback (GET /__reflex/status).
import type { DecisionInfo } from "../outcome/tracker.js";

export interface ModelPair {
  readonly requested: string | null;
  readonly sent: string;
}

export interface SessionStatusBody {
  readonly main: ModelPair | null;
  readonly subagents: readonly ModelPair[];
}

export class SessionStatus {
  readonly #main = new Map<string, ModelPair>();
  readonly #subs = new Map<string, Map<string, ModelPair>>();

  observe(d: DecisionInfo): void {
    if (d.sessionId === null || d.sentModel === null || d.turn === "side") return;
    const pair = { requested: d.requestedModel, sent: d.sentModel };
    if (d.kind === "main" && d.agentId === null) this.#main.set(d.sessionId, pair);
    else if (d.kind === "subagent" && d.agentId !== null) {
      const subs = this.#subs.get(d.sessionId) ?? new Map<string, ModelPair>();
      subs.set(d.agentId, pair);
      this.#subs.set(d.sessionId, subs);
    }
  }

  get(sessionId: string): SessionStatusBody {
    return { main: this.#main.get(sessionId) ?? null, subagents: [...(this.#subs.get(sessionId)?.values() ?? [])] };
  }
}
