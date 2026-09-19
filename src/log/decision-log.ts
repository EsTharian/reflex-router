// decisions.jsonl: one record per classified /v1/messages request (schema v:1). A `new` turn carries the backend's
// decision and the would-be plan; continuation and side requests carry decision: null, so drift in the classifier
// and the token usage of every request are visible. Never contains credentials, ids in clear, or full prompts.
import crypto from "node:crypto";
import path from "node:path";
import type { Tier } from "../config.js";
import { head } from "../privacy/budget.js";
import { redact } from "../privacy/redact.js";
import type { Effort, ReasonCode } from "../types.js";
import { JsonlWriter, type JsonlOptions } from "./jsonl.js";

/** Hard cap on the prompt preview, in code points. A constant, deliberately not configurable. */
export const PROMPT_PREVIEW_MAX = 300;

export interface PickRecord {
  readonly value: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface DecisionRecord {
  readonly v: 1;
  readonly id: string;
  readonly at: string;
  /** sha256(session id), truncated. */
  readonly session: string | null;
  readonly conv: string | null;
  readonly kind: "main" | "subagent" | "unknown";
  readonly signal: string;
  readonly signals: { readonly header: boolean; readonly s1: boolean; readonly s2: boolean; readonly s3: boolean };
  readonly turn: "new" | "continuation" | "side";
  readonly side_kind: string | null;
  readonly entrypoint: string | null;
  readonly mode_requested: string;
  readonly mode_effective: string;
  readonly degraded_reason: string | null;
  readonly shape: { readonly status: string; readonly violations: readonly string[] };
  readonly claude_version: string | null;
  readonly backend: string | null;
  readonly requested: { readonly model: string | null; readonly tier: Tier | null; readonly effort: string | null };
  readonly decision: {
    /** `picks.tier.value` is the applied pick; confidence/probabilities are the backend's answer as given. */
    readonly picks: { readonly tier: PickRecord };
    /** Which rule produced the applied pick; both readings are always logged for comparison. */
    readonly rule: "mass" | "argmax";
    readonly pick_mass: { readonly value: string; readonly above_mass: number };
    readonly pick_argmax: { readonly value: string; readonly confidence: number };
    readonly vetoes: Readonly<Record<string, number>>;
    readonly latencyMs: number;
    readonly tokensIn: number | null;
    readonly backendModel: string;
    /** Whether the Jev call reused a keep-alive connection. */
    readonly connection: "new" | "reused" | null;
  } | null;
  readonly plan: {
    readonly target: { readonly tier: Tier; readonly effort?: Effort } | null;
    readonly would_route_to: string | null;
    readonly routed_to: string | null;
    readonly reasons: readonly ReasonCode[];
    readonly would_upgrade: boolean;
  } | null;
  /** Main-chat cost guard, when it was evaluated. */
  readonly guard: { readonly allowed: boolean; readonly reason: string; readonly ctx: number | null; readonly penalty_usd: number | null } | null;
  /** Manual `!tier` override in effect for this decision (main chat: from the prompt; subagent: captured at its first request). */
  readonly override: Tier | null;
  /** Continuations: whether a pin for this conversation/agent existed; `set` on a decided new turn. */
  readonly pin: "set" | "hit" | "miss" | null;
  readonly forwarded: {
    /** What the client asked for. */
    readonly requested_model: string | null;
    /** What was actually sent upstream (after a fallback: the original again). */
    readonly model: string | null;
    readonly rewritten: boolean;
    /** Fields changed by the rewrite (src/wire/rewrite.ts), empty when not rewritten. */
    readonly fields: readonly string[];
    /** The rewritten request was rejected and the original bytes were sent instead. */
    readonly fallback: boolean;
    readonly fallback_status: number | null;
    /** The upstream's error for the rejected rewrite, `type: message`, redacted and capped at 500 characters. */
    readonly fallback_error: string | null;
  };
  readonly upstream: { readonly status: number | null; readonly msToHeaders: number | null };
  readonly usage: { readonly input: number; readonly output: number; readonly cache_read: number; readonly cache_create: number } | null;
  readonly usage_unknown_reason: string | null;
  /** Backend or pipeline error category; never a message body. */
  readonly error: string | null;
  readonly sent: { readonly keys: readonly string[]; readonly chars: number } | null;
  readonly prompt_preview?: string;
}

export const hashId = (id: string | null): string | null => (id === null ? null : crypto.createHash("sha256").update(id).digest("hex").slice(0, 16));

/** Redacted, whitespace-collapsed, capped at PROMPT_PREVIEW_MAX code points. */
export const promptPreview = (text: string): string => head(redact(text).replace(/\s+/g, " ").trim(), PROMPT_PREVIEW_MAX);

export class DecisionLog {
  readonly #writer: JsonlWriter;

  constructor(
    home: string,
    private readonly logPrompts: boolean,
    opts: JsonlOptions = {},
  ) {
    this.#writer = new JsonlWriter(path.join(home, "decisions.jsonl"), opts);
  }

  get file(): string {
    return this.#writer.file;
  }

  /** `preview` is the raw task text; it is redacted and capped here, or dropped when prompt logging is off. */
  append(record: DecisionRecord, preview: string | null): Promise<void> {
    const { prompt_preview: _ignored, ...rest } = record;
    const out: DecisionRecord = this.logPrompts && preview ? { ...rest, prompt_preview: promptPreview(preview) } : rest;
    return this.#writer.append(out);
  }

  flush(): Promise<void> {
    return this.#writer.flush();
  }
}
