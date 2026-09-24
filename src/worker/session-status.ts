// What `reflex statusline` shows: per session, the model the main chat asked for and the one reflex sent on its last
// request, the same for each subagent, the effort level REFLEX_EFFORT last applied against the client's (main chat and
// each subagent), and the estimated saving (section 8's "routed only" difference: the same token counts at the
// requested model minus at the model sent, list prices). Model ids, level names and dollar sums only, in memory only,
// served on loopback (GET /__reflex/status).
import type { DecisionRecord } from "../log/decision-log.js";
import type { DecisionInfo } from "../outcome/tracker.js";
import { toDec, type J } from "../report/records.js";
import { savedUsd } from "../report/sections.js";

export interface ModelPair {
  readonly requested: string | null;
  readonly sent: string;
}

/** The level REFLEX_EFFORT applied to a conversation's latest decided turn, and the client's own. */
export interface EffortPair {
  readonly requested: string | null;
  readonly level: string;
}

export interface SessionStatusBody {
  readonly main: ModelPair | null;
  readonly subagents: readonly ModelPair[];
  readonly effort: { readonly main: EffortPair | null; readonly subagents: readonly EffortPair[] };
  /** Estimated $ saved: this session, and every logged session (null until the log has been read). */
  readonly saved: { readonly session: number; readonly total: number | null };
}

export class SessionStatus {
  readonly #main = new Map<string, ModelPair>();
  readonly #subs = new Map<string, Map<string, ModelPair>>();
  readonly #saved = new Map<string, number>();
  readonly #mainEffort = new Map<string, EffortPair>();
  readonly #subEffort = new Map<string, Map<string, EffortPair>>();
  /** The log's total when this worker started; this worker's own records are added on top. */
  #logged: number | null = null;

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

  addRecord(record: DecisionRecord, sessionId: string | null): void {
    const d = sessionId === null ? null : toDec(record as unknown as J);
    if (d === null || sessionId === null) return;
    this.#saved.set(sessionId, (this.#saved.get(sessionId) ?? 0) + savedUsd([d]));
    // An applied level holds for the conversation until a later decided turn applies another.
    const e = d.effort;
    if (e === null || e.via === null || e.target === null || d.fallback) return;
    const pair = { requested: d.requestedEffort, level: e.target };
    if (d.kind === "main") this.#mainEffort.set(sessionId, pair);
    else if (d.kind === "subagent" && d.conv !== null) {
      const subs = this.#subEffort.get(sessionId) ?? new Map<string, EffortPair>();
      subs.set(d.conv, pair);
      this.#subEffort.set(sessionId, subs);
    }
  }

  setLoggedTotal(usd: number): void {
    this.#logged = usd;
  }

  get(sessionId: string): SessionStatusBody {
    const mine = [...this.#saved.values()].reduce((a, b) => a + b, 0);
    return {
      main: this.#main.get(sessionId) ?? null,
      subagents: [...(this.#subs.get(sessionId)?.values() ?? [])],
      effort: { main: this.#mainEffort.get(sessionId) ?? null, subagents: [...(this.#subEffort.get(sessionId)?.values() ?? [])] },
      saved: { session: this.#saved.get(sessionId) ?? 0, total: this.#logged === null ? null : this.#logged + mine },
    };
  }
}
