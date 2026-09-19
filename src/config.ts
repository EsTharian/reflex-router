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

export const DECISION_RULES = ["mass", "argmax"] as const;
/** How the tier is read from the backend's probability vector (src/policy.ts). */
export type DecisionRule = (typeof DECISION_RULES)[number];

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
  /** Interval of the decision backend's keep-alive ping; 0 disables it. */
  readonly warmIntervalMs: number;
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
  /** REFLEX_DECISION_RULE: `mass` (ordered, default) or `argmax` (Jev's own choice + confidence floor). */
  readonly decisionRule: DecisionRule;
  /** REFLEX_MASS_EPS: the most probability the mass rule leaves on tiers above its pick. */
  readonly massEps: number;
  /** Main-chat cost guard: largest one-time cache penalty ($) a model switch may cost (REFLEX_MAX_SWITCH_PENALTY_USD). */
  readonly maxSwitchPenaltyUsd: number;
  /** REFLEX_DELEGATE=1: add the delegation hint (src/delegate/hint.ts) to user-typed prompts via the UserPromptSubmit hook. Off by default. */
  readonly delegate: boolean;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: Config; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

export const DEFAULT_UPSTREAM = "https://api.anthropic.com";
export const TYPESAFE_KEY_PREFIX = "apikey_";
export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";
/** Above the first measured cold-connection p95 (1136 ms, docs/observations.md) with some headroom. */
export const DEFAULT_JEV_DEADLINE_MS = 1500;
/**
 * How often the worker pings the decision backend to keep its keep-alive connection open while nothing is being
 * decided. 0 disables it. The first decision after an idle gap otherwise pays a fresh TCP+TLS handshake
 * (docs/observations.md: p50 823 ms on a new connection vs 382 ms reused).
 */
export const DEFAULT_WARM_INTERVAL_MS = 60_000;

/** A setting's trimmed value, or undefined when it is unset, empty or only whitespace: `export X=""` means "not set", never "set to nothing". */
const setting = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v === undefined || v === "" ? undefined : v;
};

/** State directory: REFLEX_HOME, else ~/.reflex. Shared with the env-file loader, which needs it before loadConfig runs. */
export const defaultHome = (env: NodeJS.ProcessEnv, homedir: string = os.homedir()): string => setting(env, "REFLEX_HOME") ?? path.join(homedir, ".reflex");

/**
 * Every environment variable loadConfig reads (test/unit/config.test.ts keeps this list and the code in step).
 * `reflex doctor` reports the source of each one; only REFLEX_* and TYPESAFE_API_KEY may come from ~/.reflex/env.
 */
export const SETTING_NAMES: readonly string[] = [
  "REFLEX_MODE", "REFLEX_BACKEND", "REFLEX_UPSTREAM_URL", "ANTHROPIC_BASE_URL", "TYPESAFE_API_KEY", "REFLEX_JEV_BASE_URL", "REFLEX_JEV_DEADLINE_MS", "REFLEX_WARM_INTERVAL_MS",
  "REFLEX_ALLOW_FABLE", "REFLEX_TIERS", "REFLEX_UPGRADES", "REFLEX_MAIN_CHAT", "REFLEX_CLAUDE_BIN", "REFLEX_HOME", "REFLEX_IGNORE_VERSION_CHECK",
  "REFLEX_SHAPE_CHECK_N", "REFLEX_MAX_USER_CHARS", "REFLEX_MAX_ASSISTANT_CHARS", "REFLEX_LOG_PROMPTS", "REFLEX_DECISION_RULE", "REFLEX_MASS_EPS",
  "REFLEX_MAX_SWITCH_PENALTY_USD", "REFLEX_DELEGATE", "REFLEX_MODEL_HAIKU", "REFLEX_MODEL_SONNET", "REFLEX_MODEL_OPUS", "REFLEX_MODEL_FABLE",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL",
];

/** Names the claude child must never inherit: our own settings and the decision-backend credentials. */
export const isReflexEnvName = (name: string): boolean => name.startsWith("REFLEX_") || name.startsWith("TYPESAFE_");

/**
 * Names that look like ours but that nothing reads: a typo, or a variable from a plan that was never built.
 * Neither loadConfig nor anything else looks at them, and the launcher strips them from the
 * environment it gives `claude` (every REFLEX_ and TYPESAFE_ name, via isReflexEnvName), so such a variable is
 * silently dropped twice over. `REFLEX_DUMP=1`
 * was set for a whole session on the strength of a note in docs/prior-art.md before anyone noticed nothing read it.
 */
export function unknownReflexEnvNames(env: NodeJS.ProcessEnv): string[] {
  const known = new Set(SETTING_NAMES);
  return Object.keys(env).filter((n) => isReflexEnvName(n) && !known.has(n) && (env[n] ?? "").trim() !== "").sort();
}

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

  const mode = parseEnum(setting(env, "REFLEX_MODE"), MODES, "shadow", "REFLEX_MODE", errors);
  const backend = parseEnum(setting(env, "REFLEX_BACKEND"), BACKENDS, "jev", "REFLEX_BACKEND", errors);

  const upstreamRaw = setting(env, "REFLEX_UPSTREAM_URL") ?? setting(env, "ANTHROPIC_BASE_URL") ?? DEFAULT_UPSTREAM;
  const upstreamName = setting(env, "REFLEX_UPSTREAM_URL") !== undefined ? "REFLEX_UPSTREAM_URL" : "ANTHROPIC_BASE_URL";
  const upstreamUrl = parseHttpUrl(upstreamRaw, upstreamName, errors);

  const keyRaw = setting(env, "TYPESAFE_API_KEY");
  let typesafeApiKey: string | undefined;
  if (keyRaw) {
    if (keyRaw.startsWith(TYPESAFE_KEY_PREFIX)) typesafeApiKey = keyRaw;
    else warnings.push(`TYPESAFE_API_KEY does not start with "${TYPESAFE_KEY_PREFIX}"; ignoring it`);
  }

  const jevRaw = setting(env, "REFLEX_JEV_BASE_URL");
  const jevBaseUrl = jevRaw ? parseHttpUrl(jevRaw, "REFLEX_JEV_BASE_URL", errors) : DEFAULT_JEV_BASE_URL;
  const allowFable = truthy(setting(env, "REFLEX_ALLOW_FABLE"));
  const tiers = parseTiers(setting(env, "REFLEX_TIERS"), allowFable, errors, warnings);
  const models = Object.fromEntries(
    TIERS.map((t) => [t, setting(env, `REFLEX_MODEL_${t.toUpperCase()}`) ?? setting(env, `ANTHROPIC_DEFAULT_${t.toUpperCase()}_MODEL`) ?? DEFAULT_MODELS[t]]),
  ) as Record<Tier, string>;

  if (errors.length > 0 || upstreamUrl === undefined || jevBaseUrl === undefined) return { ok: false, errors: errors.length > 0 ? errors : ["invalid upstream URL"] };

  const config: Config = {
    mode,
    backend,
    upstreamUrl,
    claudeBin: setting(env, "REFLEX_CLAUDE_BIN"),
    home: defaultHome(env, homedir),
    ignoreVersionCheck: truthy(setting(env, "REFLEX_IGNORE_VERSION_CHECK")),
    typesafeApiKey,
    jevBaseUrl,
    jevDeadlineMs: parseBoundedInt(setting(env, "REFLEX_JEV_DEADLINE_MS"), DEFAULT_JEV_DEADLINE_MS, 50, 60_000, "REFLEX_JEV_DEADLINE_MS", errors),
    warmIntervalMs: parseBoundedInt(setting(env, "REFLEX_WARM_INTERVAL_MS"), DEFAULT_WARM_INTERVAL_MS, 0, 3_600_000, "REFLEX_WARM_INTERVAL_MS", errors),
    tiers,
    allowFable,
    upgrades: parseEnum(setting(env, "REFLEX_UPGRADES"), UPGRADE_POLICIES, "off", "REFLEX_UPGRADES", errors),
    mainChat: parseEnum(setting(env, "REFLEX_MAIN_CHAT"), MAIN_CHAT_POLICIES, "guarded", "REFLEX_MAIN_CHAT", errors),
    models,
    shapeCheckN: parseBoundedInt(setting(env, "REFLEX_SHAPE_CHECK_N"), 10, 1, 10_000, "REFLEX_SHAPE_CHECK_N", errors),
    maxUserChars: parseBoundedInt(setting(env, "REFLEX_MAX_USER_CHARS"), 4000, 200, 60_000, "REFLEX_MAX_USER_CHARS", errors),
    maxAssistantChars: parseBoundedInt(setting(env, "REFLEX_MAX_ASSISTANT_CHARS"), 1000, 0, 60_000, "REFLEX_MAX_ASSISTANT_CHARS", errors),
    logPrompts: !falsy(setting(env, "REFLEX_LOG_PROMPTS")),
    decisionRule: parseEnum(setting(env, "REFLEX_DECISION_RULE"), DECISION_RULES, "mass", "REFLEX_DECISION_RULE", errors),
    massEps: parseBoundedNumber(setting(env, "REFLEX_MASS_EPS"), 0.1, 0, 0.5, "REFLEX_MASS_EPS", errors),
    maxSwitchPenaltyUsd: parseBoundedNumber(setting(env, "REFLEX_MAX_SWITCH_PENALTY_USD"), 0.01, 0, 100, "REFLEX_MAX_SWITCH_PENALTY_USD", errors),
    delegate: truthy(setting(env, "REFLEX_DELEGATE")),
  };
  if (errors.length > 0) return { ok: false, errors };
  if (config.delegate && mode === "off") warnings.push("REFLEX_DELEGATE has no effect with REFLEX_MODE=off (the hint travels through reflex's hooks)");
  return { ok: true, config, warnings };
}
