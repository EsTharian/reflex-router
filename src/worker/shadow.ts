// Shadow mode: observe, decide off the critical path, record. Nothing here can change what is forwarded: the worker
// sends the original bytes before calling observe(), and every failure in here ends in a logged record, never in an
// exception on the response path. Routing (rewrites) is not implemented yet; a `route` request runs as shadow.
import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Config } from "../config.js";
import type { EffectiveMode } from "../effective-mode.js";
import { assessVersion, type VersionLevel } from "../launcher/version.js";
import { hashId, type DecisionLog, type DecisionRecord } from "../log/decision-log.js";
import { buildQuestions, judge, plan } from "../policy.js";
import { buildState } from "../privacy/state.js";
import { tierOfModel } from "../tiers.js";
import type { Log } from "../util/log.js";
import { isMessagesRequest, parseRequest, type RequestView } from "../wire/claude-code.js";
import { ShapeTracker } from "../wire/shape.js";
import { TESTED_CLAUDE_VERSIONS } from "../wire/tested-versions.generated.js";
import { BackendError, type DecisionBackend } from "../backend/types.js";
import type { Breaker } from "./breaker.js";
import { UsageTee } from "./usage-tee.js";

export interface ShadowDeps {
  readonly config: Config;
  readonly effectiveMode: EffectiveMode;
  /** Why the launcher weakened the mode, if it did. */
  readonly degradedReason: string | null;
  readonly claudeVersion: string | null;
  readonly backend: DecisionBackend | null;
  readonly breaker: Breaker;
  readonly log: DecisionLog;
  readonly logger: Log;
  readonly now?: () => number;
  readonly newId?: () => string;
}

/** What the worker hands back to an observation as the response goes by. */
export interface Observation {
  headers(status: number, headers: IncomingHttpHeaders): void;
  readonly tap: (chunk: Buffer) => void;
  /** Called once: `complete` = the response was relayed to the end. Never throws; the record is written async. */
  finish(complete: boolean): void;
}

type DecisionPart = Pick<DecisionRecord, "decision" | "plan" | "error" | "sent" | "backend">;

const SEVERITY: Readonly<Record<VersionLevel, number>> = { ok: 0, warn: 1, degrade: 2 };

interface SessionState {
  readonly shape: ShapeTracker;
}

export class Shadow {
  readonly #sessions = new Map<string, SessionState>();
  #uaDegrade: string | null = null;
  #uaChecked = false;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(private readonly d: ShadowDeps) {
    this.#now = d.now ?? Date.now;
    this.#newId = d.newId ?? (() => crypto.randomUUID());
  }

  /** True when this worker observes traffic at all (shadow, or route which currently runs as shadow). */
  static active(mode: EffectiveMode): boolean {
    return mode === "shadow" || mode === "route";
  }

  #session(v: RequestView): SessionState {
    const key = v.sessionId ?? "";
    let s = this.#sessions.get(key);
    if (!s) {
      s = { shape: new ShapeTracker(this.d.config.shapeCheckN) };
      this.#sessions.set(key, s);
    }
    return s;
  }

  /** The user-agent names the client that actually talks to us; the more severe verdict wins for the session. */
  #checkClientVersion(v: RequestView): void {
    if (this.#uaChecked || v.clientVersion === null) return;
    this.#uaChecked = true;
    const ua = assessVersion(v.clientVersion, TESTED_CLAUDE_VERSIONS);
    const launcher = assessVersion(this.d.claudeVersion, TESTED_CLAUDE_VERSIONS);
    if (ua.level === "degrade" && SEVERITY[ua.level] > SEVERITY[launcher.level] && !this.d.config.ignoreVersionCheck) this.#uaDegrade = `client_version:${ua.reason}`;
  }

  /** Returns null for requests that are not observed (not POST /v1/messages, or unparseable). Never throws. */
  observe(method: string, url: string, headers: IncomingHttpHeaders, body: Buffer): Observation | null {
    try {
      if (!isMessagesRequest(method, url)) return null;
      const parsed = parseRequest(headers, body);
      if (!parsed.ok) return null;
      return this.#observe(parsed.view);
    } catch (e) {
      this.d.logger("error", `shadow: observe failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  #observe(v: RequestView): Observation {
    const started = this.#now();
    const at = new Date(started).toISOString();
    const id = this.#newId();
    this.#checkClientVersion(v);
    const session = this.#session(v);
    const violations = session.shape.observe(v);
    const decisionP = this.#decide(v);

    let status: number | null = null;
    let msToHeaders: number | null = null;
    let tee: UsageTee | null = null;
    let finished = false;

    return {
      headers: (s, h) => {
        status = s;
        msToHeaders = this.#now() - started;
        const ct = h["content-type"];
        const ce = h["content-encoding"];
        tee = new UsageTee(typeof ct === "string" ? ct : undefined, typeof ce === "string" ? ce : undefined);
      },
      tap: (chunk) => tee?.write(chunk),
      finish: (complete) => {
        if (finished) return;
        finished = true;
        const usageP = tee ? tee.end(complete) : Promise.resolve({ usage: null, unknownReason: "no_response" });
        void Promise.all([decisionP, usageP])
          .then(([dp, u]) => {
            const degraded = [this.d.degradedReason, this.d.effectiveMode === "route" ? "route_not_available_yet" : null, this.#uaDegrade, session.shape.reason].filter(Boolean);
            const record: DecisionRecord = {
              v: 1,
              id,
              at,
              session: hashId(v.sessionId),
              conv: v.convKey,
              kind: v.kind,
              signal: v.signal,
              signals: v.signals,
              turn: v.turn,
              side_kind: v.sideKind,
              entrypoint: v.entrypoint,
              mode_requested: this.d.config.mode,
              mode_effective: "shadow",
              degraded_reason: degraded.length > 0 ? degraded.join(";") : null,
              shape: { status: session.shape.status, violations: violations.map((x) => x.check) },
              claude_version: v.clientVersion ?? this.d.claudeVersion,
              requested: { model: v.requestedModel, tier: tierOfModel(v.requestedModel), effort: v.requestedEffort },
              guard: null,
              override: null,
              forwarded: { model: v.requestedModel, rewritten: false, fallback: false },
              upstream: { status, msToHeaders },
              usage: u.usage ? { input: u.usage.input, output: u.usage.output, cache_read: u.usage.cacheRead, cache_create: u.usage.cacheCreate } : null,
              usage_unknown_reason: u.unknownReason,
              ...dp,
            };
            return this.d.log.append(record, v.turn === "new" ? v.task : null);
          })
          .catch((e: unknown) => this.d.logger("error", `shadow: record failed: ${e instanceof Error ? e.message : String(e)}`));
      },
    };
  }

  /** Always resolves. Only positively identified `new` turns of a known kind ever reach the backend. */
  async #decide(v: RequestView): Promise<DecisionPart> {
    const none: DecisionPart = { decision: null, plan: null, error: null, sent: null, backend: null };
    if (v.turn !== "new" || v.kind === "unknown" || v.task === null) return none;
    const backend = this.d.backend;
    if (!backend) return { ...none, error: "no_backend" };
    if (!this.d.breaker.closed) return { ...none, backend: backend.id, error: "breaker_open" };
    const cfg = this.d.config;
    const kind = v.kind;
    let sent: DecisionPart["sent"] = null;
    try {
      const built = buildState({ kind, task: v.task, previousAssistantText: v.previousAssistantText, requestedModel: v.requestedModel }, cfg);
      sent = built.sent;
      const decision = await backend.decide(built.state, buildQuestions(cfg), { signal: new AbortController().signal });
      this.d.breaker.success();
      const j = judge(decision, cfg);
      if (!j.ok) return { ...none, backend: backend.id, sent, error: `invalid_answer:${j.error}` };
      const p = plan({ kind, requestedModel: v.requestedModel }, j.judgement, cfg);
      return {
        backend: backend.id,
        sent,
        error: null,
        decision: {
          picks: { tier: { value: j.judgement.tier.value, confidence: j.judgement.tier.confidence, probabilities: j.judgement.tier.probabilities } },
          vetoes: j.judgement.vetoes,
          latencyMs: decision.latencyMs,
          tokensIn: decision.tokensIn,
          backendModel: decision.backendModel,
          connection: decision.connection,
        },
        plan: {
          target: p.target,
          would_route_to: p.target ? cfg.models[p.target.tier] : null,
          routed_to: v.requestedModel, // shadow: never rewritten
          reasons: p.reasons,
          would_upgrade: p.wouldUpgrade,
        },
      };
    } catch (e) {
      if (e instanceof BackendError) {
        if (e.kind !== "aborted") this.d.breaker.failure();
        return { ...none, backend: backend.id, sent, error: e.status !== undefined ? `backend:${e.kind}:${e.status}` : `backend:${e.kind}` };
      }
      this.d.logger("error", `shadow: decision failed: ${e instanceof Error ? e.message : String(e)}`);
      return { ...none, backend: backend.id, sent, error: "internal" };
    }
  }
}
