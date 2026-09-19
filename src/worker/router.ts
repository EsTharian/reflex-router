// Classification, decisions, pins and rewrites for POST /v1/messages. Two modes:
//   shadow  forward the original bytes immediately; decide off the critical path; record what would have happened.
//   route   a positively identified `new` turn waits for its decision (bounded by the Jev deadline) and is rewritten
//           when policy, the main-chat cost guard, disabled tiers and the verified-rewrite list all allow it; its
//           continuations reuse that pin (per conversation, i.e. per agent id for subagents). Side calls always pass
//           through unchanged.
// Every failure ends in "forward the original bytes"; the retry-with-original on a rejected rewrite lives in server.ts.
import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Config, Tier } from "../config.js";
import type { EffectiveMode } from "../effective-mode.js";
import { guard, type GuardResult } from "../guard.js";
import { assessVersion, type VersionLevel } from "../launcher/version.js";
import { hashId, type DecisionLog, type DecisionRecord } from "../log/decision-log.js";
import { parseOverride } from "../overrides.js";
import { buildQuestions, judge, plan } from "../policy.js";
import { buildState } from "../privacy/state.js";
import { tierOfModel, tierRank } from "../tiers.js";
import type { ReasonCode } from "../types.js";
import type { Log } from "../util/log.js";
import { isMessagesRequest, parseRequest, type RequestView } from "../wire/claude-code.js";
import { isVerifiedRetarget, retarget, retargetBetas } from "../wire/rewrite.js";
import { ShapeTracker } from "../wire/shape.js";
import { TESTED_CLAUDE_VERSIONS } from "../wire/tested-versions.generated.js";
import { BackendError, type DecisionBackend } from "../backend/types.js";
import type { Breaker } from "./breaker.js";
import { UsageTee } from "./usage-tee.js";

/** A tier whose rewritten request was rejected stays off for the session this long. */
export const TIER_DISABLE_MS = 30 * 60 * 1000;
/** Safety margin on top of the backend's own deadline before route mode gives up waiting. */
const DECISION_GRACE_MS = 250;

export interface RouterDeps {
  readonly config: Config;
  readonly effectiveMode: EffectiveMode;
  readonly degradedReason: string | null;
  readonly claudeVersion: string | null;
  readonly backend: DecisionBackend | null;
  readonly breaker: Breaker;
  readonly log: DecisionLog;
  readonly logger: Log;
  readonly now?: () => number;
  readonly newId?: () => string;
}

/** Handed to server.ts for one request as it is forwarded. */
export interface Observation {
  headers(status: number, headers: IncomingHttpHeaders): void;
  readonly tap: (chunk: Buffer) => void;
  /** The rewritten request was rejected with `status` (redacted error summary); the original bytes are sent instead. */
  fallback(status: number, error: string | null): void;
  /** Called once: `complete` = the response was relayed to the end. Never throws; the record is written async. */
  finish(complete: boolean): void;
}

export interface Prepared {
  /** What to send upstream first. */
  readonly body: Buffer;
  /** Headers to send with `body` when the rewrite changed them (e.g. a beta the target rejects); else undefined. */
  readonly headers?: IncomingHttpHeaders;
  /** True when `body` is a rewrite; server.ts then retries with the original bytes on a rejection. */
  readonly rewritten: boolean;
  readonly obs: Observation | null;
}

interface Pin {
  readonly target: { readonly tier: Tier; readonly model: string } | null;
  readonly from: Tier | null;
}
interface ConvState {
  pin: Pin | null;
  /** Tier that last served a new/continuation request of this conversation: where its prompt cache lives. */
  cacheTier: Tier | null;
  /** Prompt size (input + cache read + cache write) of that last response. */
  lastCtx: number | null;
}
interface SessionState {
  readonly shape: ShapeTracker;
  /** `!tier` from the latest user-typed main-chat turn; subagents capture it at their first request. */
  turnOverride: Tier | null;
  readonly disabledUntil: Map<Tier, number>;
  readonly convs: Map<string, ConvState>;
}

type DecisionPart = Pick<DecisionRecord, "decision" | "plan" | "error" | "sent" | "backend" | "guard" | "override">;
interface Outcome {
  readonly part: DecisionPart;
  /** Where route mode sends this turn; null = the requested model. */
  readonly target: { readonly tier: Tier; readonly model: string } | null;
  readonly reasons: ReasonCode[];
}

const SEVERITY: Readonly<Record<VersionLevel, number>> = { ok: 0, warn: 1, degrade: 2 };
const NONE: DecisionPart = { decision: null, plan: null, error: null, sent: null, backend: null, guard: null, override: null };
const guardRecord = (g: GuardResult | null): DecisionPart["guard"] => (g ? { allowed: g.allowed, reason: g.reason, ctx: g.ctx, penalty_usd: g.penaltyUsd } : null);

export class Router {
  readonly #sessions = new Map<string, SessionState>();
  #uaDegrade: string | null = null;
  #uaChecked = false;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(private readonly d: RouterDeps) {
    this.#now = d.now ?? Date.now;
    this.#newId = d.newId ?? (() => crypto.randomUUID());
  }

  /** True when this worker classifies traffic at all. */
  static active(mode: EffectiveMode): boolean {
    return mode === "shadow" || mode === "route";
  }

  #session(v: RequestView): SessionState {
    const key = v.sessionId ?? "";
    let s = this.#sessions.get(key);
    if (!s) {
      s = { shape: new ShapeTracker(this.d.config.shapeCheckN), turnOverride: null, disabledUntil: new Map(), convs: new Map() };
      this.#sessions.set(key, s);
    }
    return s;
  }

  #conv(s: SessionState, key: string): ConvState {
    let c = s.convs.get(key);
    if (!c) {
      c = { pin: null, cacheTier: null, lastCtx: null };
      s.convs.set(key, c);
    }
    return c;
  }

  /** The user-agent names the client that actually talks to us; the more severe verdict wins. */
  #checkClientVersion(v: RequestView): void {
    if (this.#uaChecked || v.clientVersion === null) return;
    this.#uaChecked = true;
    const ua = assessVersion(v.clientVersion, TESTED_CLAUDE_VERSIONS);
    const launcher = assessVersion(this.d.claudeVersion, TESTED_CLAUDE_VERSIONS);
    if (ua.level === "degrade" && SEVERITY[ua.level] > SEVERITY[launcher.level] && !this.d.config.ignoreVersionCheck) this.#uaDegrade = `client_version:${ua.reason}`;
  }

  #tierDisabled(s: SessionState, t: Tier): boolean {
    const until = s.disabledUntil.get(t);
    return until !== undefined && this.#now() < until;
  }

  /** Never throws. Non-/v1/messages and unparseable requests get `obs: null` and are forwarded untouched. */
  async prepare(method: string, url: string, headers: IncomingHttpHeaders, body: Buffer): Promise<Prepared> {
    const untouched: Prepared = { body, rewritten: false, obs: null };
    try {
      if (!isMessagesRequest(method, url)) return untouched;
      const parsed = parseRequest(headers, body);
      if (!parsed.ok) return untouched;
      return await this.#prepare(parsed.view, body, headers);
    } catch (e) {
      this.d.logger("error", `router: prepare failed: ${e instanceof Error ? e.message : String(e)}`);
      return untouched;
    }
  }

  async #prepare(v: RequestView, body: Buffer, headers: IncomingHttpHeaders): Promise<Prepared> {
    const started = this.#now();
    const at = new Date(started).toISOString();
    const id = this.#newId();
    this.#checkClientVersion(v);
    const s = this.#session(v);
    const violations = s.shape.observe(v);
    const routing = this.d.effectiveMode === "route" && s.shape.status !== "degraded" && this.#uaDegrade === null;
    const conv = v.convKey !== null && v.turn !== "side" ? this.#conv(s, v.convKey) : null;
    const requestedTier = tierOfModel(v.requestedModel);

    let outcomeP: Promise<Outcome> = Promise.resolve({ part: NONE, target: null, reasons: [] });
    let pinState: DecisionRecord["pin"] = null;
    let sendBody = body;
    let sendHeaders: IncomingHttpHeaders | undefined;
    let fields: readonly string[] = [];
    let sentModel = v.requestedModel;
    let extraReasons: ReasonCode[] = [];
    /** Retargets body and beta header to `to`; false when the body cannot be rewritten. */
    const applyRetarget = (from: Tier, to: Tier, model: string): boolean => {
      const r = retarget(body, { from, to, model });
      if (!r.ok) return false;
      const beta = headers["anthropic-beta"];
      const b = retargetBetas(typeof beta === "string" ? beta : undefined, to);
      sendBody = r.body;
      fields = [...r.fields, ...b.stripped.map((x) => `anthropic-beta:-${x}`)];
      if (b.stripped.length > 0) sendHeaders = { ...headers, "anthropic-beta": b.value };
      sentModel = model;
      return true;
    };

    if (v.turn === "new") {
      outcomeP = this.#decide(v, s, conv, routing);
      if (routing) {
        let outcome = await this.#bounded(outcomeP);
        // A decision that never arrived counts as a backend failure: a main-chat pin below the requested tier stays.
        const pinned = conv?.pin?.target;
        if (outcome.part.error === "decision_late" && v.kind === "main" && pinned && !this.#tierDisabled(s, pinned.tier)) {
          const reasons: ReasonCode[] = ["stay_pinned_backend_error"];
          outcome = { ...outcome, target: pinned, reasons, part: { ...outcome.part, plan: { target: null, would_route_to: null, routed_to: v.requestedModel, reasons, would_upgrade: false } } };
        }
        if (conv) {
          conv.pin = { target: outcome.target, from: requestedTier };
          pinState = "set";
        }
        if (outcome.target && requestedTier && !applyRetarget(requestedTier, outcome.target.tier, outcome.target.model)) {
          extraReasons = ["rewrite_failed"];
          if (conv) conv.pin = { target: null, from: requestedTier };
        }
        outcomeP = Promise.resolve(outcome);
      }
    } else if (v.turn === "continuation" && conv) {
      pinState = conv.pin ? "hit" : "miss";
      const t = conv.pin?.target;
      if (routing && t && requestedTier && !this.#tierDisabled(s, t.tier) && !applyRetarget(requestedTier, t.tier, t.model)) extraReasons = ["rewrite_failed"];
    }

    let status: number | null = null;
    let msToHeaders: number | null = null;
    let tee: UsageTee | null = null;
    let finished = false;
    let fallbackStatus: number | null = null;
    let fallbackError: string | null = null;
    const rewritten = sendBody !== body;
    const routedTier = rewritten ? tierOfModel(sentModel) : null;

    const obs: Observation = {
      headers: (st, h) => {
        status = st;
        msToHeaders = this.#now() - started;
        const ct = h["content-type"];
        const ce = h["content-encoding"];
        tee = new UsageTee(typeof ct === "string" ? ct : undefined, typeof ce === "string" ? ce : undefined);
      },
      tap: (chunk) => tee?.write(chunk),
      fallback: (st, err) => {
        fallbackStatus = st;
        fallbackError = err;
        sentModel = v.requestedModel;
        if (routedTier) s.disabledUntil.set(routedTier, this.#now() + TIER_DISABLE_MS);
        if (conv) conv.pin = { target: null, from: requestedTier }; // the rest of this loop stays on the requested model
      },
      finish: (complete) => {
        if (finished) return;
        finished = true;
        const usageP = tee ? tee.end(complete) : Promise.resolve({ usage: null, unknownReason: "no_response" });
        void Promise.all([outcomeP, usageP])
          .then(([outcome, u]) => {
            if (conv && u.usage && status === 200) {
              conv.cacheTier = tierOfModel(sentModel);
              conv.lastCtx = u.usage.input + u.usage.cacheRead + u.usage.cacheCreate;
            }
            const degraded = [this.d.degradedReason, this.#uaDegrade, s.shape.reason].filter(Boolean);
            const p = outcome.part.plan;
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
              mode_effective: routing ? "route" : "shadow",
              degraded_reason: degraded.length > 0 ? degraded.join(";") : null,
              shape: { status: s.shape.status, violations: violations.map((x) => x.check) },
              claude_version: v.clientVersion ?? this.d.claudeVersion,
              requested: { model: v.requestedModel, tier: requestedTier, effort: v.requestedEffort },
              ...outcome.part,
              plan: p ? { ...p, routed_to: sentModel, reasons: [...p.reasons, ...extraReasons] } : extraReasons.length > 0 ? { target: null, would_route_to: null, routed_to: sentModel, reasons: extraReasons, would_upgrade: false } : null,
              pin: pinState,
              forwarded: { requested_model: v.requestedModel, model: sentModel, rewritten: rewritten && fallbackStatus === null, fields: rewritten ? fields : [], fallback: fallbackStatus !== null, fallback_status: fallbackStatus, fallback_error: fallbackError },
              upstream: { status, msToHeaders },
              usage: u.usage ? { input: u.usage.input, output: u.usage.output, cache_read: u.usage.cacheRead, cache_create: u.usage.cacheCreate } : null,
              usage_unknown_reason: u.unknownReason,
            };
            return this.d.log.append(record, v.turn === "new" ? v.task : null);
          })
          .catch((e: unknown) => this.d.logger("error", `router: record failed: ${e instanceof Error ? e.message : String(e)}`));
      },
    };
    return { body: sendBody, ...(sendHeaders ? { headers: sendHeaders } : {}), rewritten, obs };
  }

  /** Route mode never waits longer than the backend deadline plus a small grace; a late decision fails open. */
  async #bounded(p: Promise<Outcome>): Promise<Outcome> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve({ part: { ...NONE, error: "decision_late" }, target: null, reasons: [] }), this.d.config.jevDeadlineMs + DECISION_GRACE_MS);
    });
    try {
      return await Promise.race([p, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Always resolves. Only positively identified `new` turns of a known kind are decided. */
  async #decide(v: RequestView, s: SessionState, conv: ConvState | null, routing: boolean): Promise<Outcome> {
    const none = (part: Partial<DecisionPart> = {}, reasons: ReasonCode[] = []): Outcome => ({ part: { ...NONE, ...part }, target: null, reasons });
    if (v.kind === "unknown" || v.task === null) return none();
    const cfg = this.d.config;
    const kind = v.kind;
    const requested = tierOfModel(v.requestedModel);

    // Overrides: a main-chat turn sets (or clears) it; a subagent captures it at its first request.
    if (kind === "main") s.turnOverride = parseOverride(v.task);
    const override = s.turnOverride;
    const planRecord = (target: Tier | null, reasons: ReasonCode[], wouldUpgrade = false): DecisionPart["plan"] => ({
      target: target ? { tier: target } : null,
      would_route_to: target ? cfg.models[target] : null,
      routed_to: v.requestedModel,
      reasons,
      would_upgrade: wouldUpgrade,
    });
    /** `policyTarget` is what the record shows as the plan's target; `candidate` is what may actually be routed. */
    const finalize = (policyTarget: Tier | null, candidate: Tier | null, reasons: ReasonCode[], part: Partial<DecisionPart>, g: GuardResult | null): Outcome => {
      let routeTo: Tier | null = candidate;
      const why = [...reasons];
      if (routeTo !== null && this.#tierDisabled(s, routeTo)) {
        why.push("tier_disabled");
        routeTo = null;
      }
      if (routeTo !== null && (requested === null || !isVerifiedRetarget(requested, routeTo))) {
        why.push("rewrite_unverified");
        routeTo = null;
      }
      return {
        part: { ...NONE, ...part, guard: guardRecord(g), override, plan: planRecord(policyTarget, why, part.plan?.would_upgrade ?? false) },
        target: routeTo !== null ? { tier: routeTo, model: cfg.models[routeTo] } : null,
        reasons: why,
      };
    };

    if (override !== null) {
      if (override === requested) return finalize(null, null, ["override", "same_tier"], {}, null);
      return finalize(override, override, ["override"], {}, null); // bypasses backend, confidence and the cost guard
    }
    if (kind === "main" && cfg.mainChat === "never") return none({ plan: planRecord(null, ["main_chat_disabled"]) });

    // The tier this main-chat conversation is pinned to now (its last decided target); the requested tier when it
    // has none. The guard only ever decides whether to LEAVE that tier for a cheaper one; a refusal keeps it.
    const current: Tier | null = kind === "main" && conv?.pin ? (conv.pin.target?.tier ?? requested) : requested;
    const belowRequested = current !== null && requested !== null && tierRank(current) < tierRank(requested);
    // A backend failure on a conversation pinned below the requested tier keeps the pin: the pin is a prior
    // decision, not an error path (tool-loop continuations stay pinned without the backend too). `reflex:<tier>`
    // leaves it. Everywhere else a failure forwards the request unchanged.
    const failed = (part: Partial<DecisionPart>): Outcome =>
      kind === "main" && belowRequested && current !== null ? finalize(null, current, ["stay_pinned_backend_error"], part, null) : none(part);

    // Main-chat cost guard, evaluated before the backend in route mode: a conversation still on the requested tier
    // skips the backend when even the cheapest enabled tier cannot pass. A conversation pinned below the requested
    // tier always asks (the answer may move it back up).
    const fresh = v.facts.nonSystemMessages === 1;
    const guardFor = (to: Tier): GuardResult =>
      guard({ cacheTier: conv?.cacheTier ?? null, to, ctxTokens: conv?.lastCtx ?? null, ttl: v.facts.betaExtendedCacheTtl ? "1h" : "5m", fresh, maxPenaltyUsd: cfg.maxSwitchPenaltyUsd });
    if (kind === "main" && routing && requested !== null && !belowRequested) {
      const cheapest = cfg.tiers.find((t) => tierRank(t) < tierRank(requested));
      if (cheapest === undefined) return none({ plan: planRecord(null, ["no_enabled_tier"]) });
      const pre = guardFor(cheapest);
      if (!pre.allowed) return none({ guard: guardRecord(pre), plan: planRecord(null, ["guard_blocked"]) });
    }

    const backend = this.d.backend;
    if (!backend) return failed({ error: "no_backend" });
    if (!this.d.breaker.closed) return failed({ backend: backend.id, error: "breaker_open" });
    let sent: DecisionPart["sent"] = null;
    try {
      const built = buildState({ kind, task: v.task, previousAssistantText: v.previousAssistantText, requestedModel: v.requestedModel }, cfg);
      sent = built.sent;
      const decision = await backend.decide(built.state, buildQuestions(cfg), { signal: new AbortController().signal });
      this.d.breaker.success();
      const j = judge(decision, cfg);
      if (!j.ok) return failed({ backend: backend.id, sent, error: `invalid_answer:${j.error}` });
      const p = plan({ kind, requestedModel: v.requestedModel }, j.judgement, cfg);
      const part: Partial<DecisionPart> = {
        backend: backend.id,
        sent,
        decision: {
          picks: { tier: { value: j.judgement.tier.value, confidence: j.judgement.tier.confidence, probabilities: j.judgement.tier.probabilities } },
          rule: j.judgement.rule,
          pick_mass: { value: j.judgement.readings.mass.value, above_mass: j.judgement.readings.mass.aboveMass },
          pick_argmax: { value: j.judgement.readings.argmax.value, confidence: j.judgement.readings.argmax.confidence },
          vetoes: j.judgement.vetoes,
          latencyMs: decision.latencyMs,
          tokensIn: decision.tokensIn,
          backendModel: decision.backendModel,
          connection: decision.connection,
        },
        plan: planRecord(p.target?.tier ?? null, [...p.reasons], p.wouldUpgrade),
      };
      const policyTarget = p.target?.tier ?? null;
      let candidate = policyTarget;
      const reasons = [...p.reasons];
      let g: GuardResult | null = null;
      if (kind === "main" && requested !== null && current !== null) {
        // Where the policy would put this turn; "no target" means "stay on the requested tier".
        const desired = policyTarget ?? requested;
        if (tierRank(desired) > tierRank(current)) {
          // Moving up is never guarded: quality first, and the backend asked for more than the current tier.
          candidate = desired === requested ? null : desired;
          if (belowRequested) reasons.push("return_up");
        } else if (desired === current) {
          candidate = current === requested ? null : current;
          if (belowRequested) reasons.push("stay_pinned");
        } else {
          // Moving further down leaves the conversation's cache: the guard decides; a refusal keeps the current tier.
          g = guardFor(desired);
          if (!g.allowed) {
            reasons.push("guard_blocked");
            candidate = current === requested ? null : current;
            if (belowRequested) reasons.push("stay_pinned");
          }
        }
      }
      return finalize(policyTarget, candidate, reasons, part, g);
    } catch (e) {
      if (e instanceof BackendError) {
        if (e.kind !== "aborted") this.d.breaker.failure();
        return failed({ backend: backend.id, sent, error: e.status !== undefined ? `backend:${e.kind}:${e.status}` : `backend:${e.kind}` });
      }
      this.d.logger("error", `router: decision failed: ${e instanceof Error ? e.message : String(e)}`);
      return failed({ backend: backend.id, sent, error: "internal" });
    }
  }
}
