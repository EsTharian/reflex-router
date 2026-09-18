// The ONLY module that reads process.env for configuration. Everything else takes a Config.
import os from "node:os";
import path from "node:path";

export const MODES = ["route", "shadow", "off"] as const;
export type Mode = (typeof MODES)[number];

export const BACKENDS = ["jev", "local"] as const;
export type BackendId = (typeof BACKENDS)[number];

export const TIERS = ["haiku", "sonnet", "opus", "fable"] as const;
export type Tier = (typeof TIERS)[number];

export const MAIN_CHAT_POLICIES = ["guarded", "never"] as const;
export type MainChatPolicy = (typeof MAIN_CHAT_POLICIES)[number];

export const UPGRADE_POLICIES = ["off", "confident", "on"] as const;
export type UpgradePolicy = (typeof UPGRADE_POLICIES)[number];

/** Built-in tier -> model id defaults; overridden by REFLEX_MODEL_<TIER>, then ANTHROPIC_DEFAULT_<TIER>_MODEL. */
export const DEFAULT_MODELS: Readonly<Record<Tier, string>> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
  fable: "claude-fable-5-1",
};

export interface Config {
  /** What the user asked for. The mode actually used is decided by resolveEffectiveMode(). */
  readonly mode: Mode;
  readonly backend: BackendId;
  /** Where Anthropic-bound traffic goes: REFLEX_UPSTREAM_URL, else the user's own ANTHROPIC_BASE_URL, else api.anthropic.com. */
  readonly upstreamUrl: string;
  /** REFLEX_CLAUDE_BIN override; undefined means "find `claude` on PATH". */
  readonly claudeBin: string | undefined;
  /** State directory (logs, decision journal). Default ~/.reflex. */
  readonly home: string;
  /** REFLEX_IGNORE_VERSION_CHECK=1: never degrade because of the Claude Code version (the warning stays). */
  readonly ignoreVersionCheck: boolean;
  /** TypeSafe key. Only ever held by the launcher/worker; never forwarded, logged, or given to the claude child. */
  readonly typesafeApiKey: string | undefined;
  /** Jev endpoint origin (REFLEX_JEV_BASE_URL); the path /v1/systemone is appended. */
  readonly jevBaseUrl: string;
  /** Hard deadline for one Jev decision, connection setup included (REFLEX_JEV_DEADLINE_MS). Expiry fails open. */
  readonly jevDeadlineMs: number;
  /** Tiers a request may be routed to (REFLEX_TIERS). Fable is only present when REFLEX_ALLOW_FABLE=1. */
  readonly tiers: readonly Tier[];
  readonly allowFable: boolean;
  readonly upgrades: UpgradePolicy;
  readonly mainChat: MainChatPolicy;
  /** Tier -> model id used when a request is (or would be) routed to that tier. */
  readonly models: Readonly<Record<Tier, string>>;
  /** Shape assertions run on the first N classified requests of a session (REFLEX_SHAPE_CHECK_N). */
  readonly shapeCheckN: number;
  /** Privacy budget for what is sent to the decision backend. */
  readonly maxUserChars: number;
  readonly maxAssistantChars: number;
  /** REFLEX_LOG_PROMPTS=0 omits the (redacted, 300-char) prompt preview from the decision log. */
  readonly logPrompts: boolean;
  /** Main-chat cost guard: largest one-time cache penalty ($) a model switch may cost (REFLEX_MAX_SWITCH_PENALTY_USD). */
  readonly maxSwitchPenaltyUsd: number;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: Config; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

export const DEFAULT_UPSTREAM = "https://api.anthropic.com";
export const TYPESAFE_KEY_PREFIX = "apikey_";
export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";
/** Above the first measured cold-connection p95 (1136 ms, docs/shadow-observations.md) with some headroom. */
export const DEFAULT_JEV_DEADLINE_MS = 1500;

/** Names the claude child must never inherit: our own settings and the decision-backend credentials. */
export const isReflexEnvName = (name: string): boolean => name.startsWith("REFLEX_") || name.startsWith("TYPESAFE_");

const truthy = (v: string | undefined): boolean => v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());

function parseEnum<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T, name: string, errors: string[]): T {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if ((allowed as readonly string[]).includes(v)) return v as T;
  errors.push(`${name}=${JSON.stringify(raw)} is not one of: ${allowed.join(", ")}`);
  return fallback;
}

const falsy = (v: string | undefined): boolean => v !== undefined && ["0", "false", "no", "off"].includes(v.trim().toLowerCase());

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number, name: string, errors: string[]): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  errors.push(`${name}=${JSON.stringify(raw)} must be an integer between ${min} and ${max}`);
  return fallback;
}

function parseBoundedNumber(raw: string | undefined, fallback: number, min: number, max: number, name: string, errors: string[]): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (Number.isFinite(n) && n >= min && n <= max) return n;
  errors.push(`${name}=${JSON.stringify(raw)} must be a number between ${min} and ${max}`);
  return fallback;
}

function parseTiers(raw: string | undefined, allowFable: boolean, errors: string[], warnings: string[]): Tier[] {
  const fallback: Tier[] = ["haiku", "sonnet", "opus"];
  if (raw === undefined || raw.trim() === "") return allowFable ? [...fallback, "fable"] : fallback;
  const out: Tier[] = [];
  for (const t of raw.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    if (!(TIERS as readonly string[]).includes(t)) {
      errors.push(`REFLEX_TIERS contains unknown tier ${JSON.stringify(t)} (known: ${TIERS.join(", ")})`);
      continue;
    }
    if (t === "fable" && !allowFable) {
      warnings.push("REFLEX_TIERS lists fable but REFLEX_ALLOW_FABLE is not set; fable stays disabled");
      continue;
    }
    if (!out.includes(t as Tier)) out.push(t as Tier);
  }
  return TIERS.filter((t) => out.includes(t)); // canonical cheapest-first order
}

function parseHttpUrl(raw: string, name: string, errors: string[]): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
    return u.href.replace(/\/+$/, "");
  } catch {
    errors.push(`${name} must be an http(s) URL`);
    return undefined;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv, homedir: string = os.homedir()): ConfigResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const mode = parseEnum(env["REFLEX_MODE"], MODES, "shadow", "REFLEX_MODE", errors);
  const backend = parseEnum(env["REFLEX_BACKEND"], BACKENDS, "jev", "REFLEX_BACKEND", errors);

  const upstreamRaw = env["REFLEX_UPSTREAM_URL"] ?? env["ANTHROPIC_BASE_URL"] ?? DEFAULT_UPSTREAM;
  const upstreamName = env["REFLEX_UPSTREAM_URL"] !== undefined ? "REFLEX_UPSTREAM_URL" : "ANTHROPIC_BASE_URL";
  const upstreamUrl = parseHttpUrl(upstreamRaw, upstreamName, errors);

  const keyRaw = env["TYPESAFE_API_KEY"]?.trim();
  let typesafeApiKey: string | undefined;
  if (keyRaw) {
    if (keyRaw.startsWith(TYPESAFE_KEY_PREFIX)) typesafeApiKey = keyRaw;
    else warnings.push(`TYPESAFE_API_KEY does not start with "${TYPESAFE_KEY_PREFIX}"; ignoring it`);
  }

  const jevRaw = env["REFLEX_JEV_BASE_URL"]?.trim();
  const jevBaseUrl = jevRaw ? parseHttpUrl(jevRaw, "REFLEX_JEV_BASE_URL", errors) : DEFAULT_JEV_BASE_URL;
  const allowFable = truthy(env["REFLEX_ALLOW_FABLE"]);
  const tiers = parseTiers(env["REFLEX_TIERS"], allowFable, errors, warnings);
  const models = Object.fromEntries(
    TIERS.map((t) => [t, env[`REFLEX_MODEL_${t.toUpperCase()}`]?.trim() || env[`ANTHROPIC_DEFAULT_${t.toUpperCase()}_MODEL`]?.trim() || DEFAULT_MODELS[t]]),
  ) as Record<Tier, string>;

  if (errors.length > 0 || upstreamUrl === undefined || jevBaseUrl === undefined) return { ok: false, errors: errors.length > 0 ? errors : ["invalid upstream URL"] };

  const config: Config = {
    mode,
    backend,
    upstreamUrl,
    claudeBin: env["REFLEX_CLAUDE_BIN"]?.trim() || undefined,
    home: env["REFLEX_HOME"]?.trim() || path.join(homedir, ".reflex"),
    ignoreVersionCheck: truthy(env["REFLEX_IGNORE_VERSION_CHECK"]),
    typesafeApiKey,
    jevBaseUrl,
    jevDeadlineMs: parseBoundedInt(env["REFLEX_JEV_DEADLINE_MS"], DEFAULT_JEV_DEADLINE_MS, 50, 60_000, "REFLEX_JEV_DEADLINE_MS", errors),
    tiers,
    allowFable,
    upgrades: parseEnum(env["REFLEX_UPGRADES"], UPGRADE_POLICIES, "off", "REFLEX_UPGRADES", errors),
    mainChat: parseEnum(env["REFLEX_MAIN_CHAT"], MAIN_CHAT_POLICIES, "guarded", "REFLEX_MAIN_CHAT", errors),
    models,
    shapeCheckN: parseBoundedInt(env["REFLEX_SHAPE_CHECK_N"], 10, 1, 10_000, "REFLEX_SHAPE_CHECK_N", errors),
    maxUserChars: parseBoundedInt(env["REFLEX_MAX_USER_CHARS"], 4000, 200, 60_000, "REFLEX_MAX_USER_CHARS", errors),
    maxAssistantChars: parseBoundedInt(env["REFLEX_MAX_ASSISTANT_CHARS"], 1000, 0, 60_000, "REFLEX_MAX_ASSISTANT_CHARS", errors),
    logPrompts: !falsy(env["REFLEX_LOG_PROMPTS"]),
    maxSwitchPenaltyUsd: parseBoundedNumber(env["REFLEX_MAX_SWITCH_PENALTY_USD"], 0.01, 0, 100, "REFLEX_MAX_SWITCH_PENALTY_USD", errors),
  };
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config, warnings };
}
