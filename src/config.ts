// The ONLY module that reads process.env for configuration. Everything else takes a Config.
import os from "node:os";
import path from "node:path";

export const MODES = ["route", "shadow", "off"] as const;
export type Mode = (typeof MODES)[number];

export const BACKENDS = ["jev", "local"] as const;
export type BackendId = (typeof BACKENDS)[number];

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
}

export type ConfigResult =
  | { readonly ok: true; readonly config: Config; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

export const DEFAULT_UPSTREAM = "https://api.anthropic.com";
export const TYPESAFE_KEY_PREFIX = "apikey_";

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

  if (errors.length > 0 || upstreamUrl === undefined) return { ok: false, errors: errors.length > 0 ? errors : ["invalid upstream URL"] };

  const config: Config = {
    mode,
    backend,
    upstreamUrl,
    claudeBin: env["REFLEX_CLAUDE_BIN"]?.trim() || undefined,
    home: env["REFLEX_HOME"]?.trim() || path.join(homedir, ".reflex"),
    ignoreVersionCheck: truthy(env["REFLEX_IGNORE_VERSION_CHECK"]),
    typesafeApiKey,
  };
  return { ok: true, config, warnings };
}
