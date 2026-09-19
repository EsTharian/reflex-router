import fs from "node:fs";
import { loadConfig, SETTING_NAMES } from "./config.js";
import { resolveEffectiveMode } from "./effective-mode.js";
import { mergeEnvFile, type MergedEnv } from "./env-file.js";
import { resolveClaude, realResolveIO } from "./launcher/claude-bin.js";
import { assessVersion, describeVerdict, probeClaudeVersion } from "./launcher/version.js";
import { sanitizedEnv, type LaunchIO } from "./launcher/launch.js";
import { TESTED_CLAUDE_VERSIONS } from "./wire/tested-versions.generated.js";

export function packageVersion(): string {
  try {
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function versionCommand(io: Pick<LaunchIO, "stderr"> & { stdout: (t: string) => void }): number {
  io.stdout(`reflex ${packageVersion()}\n`);
  return 0;
}

/** A setting's value as doctor shows it: never the key, and URLs without credentials or query. */
function shownValue(name: string, value: string): string {
  if (name === "TYPESAFE_API_KEY") return "(set, not shown)";
  if (name.endsWith("_URL")) {
    try {
      const u = new URL(value);
      return `${u.origin}${u.pathname === "/" ? "" : u.pathname}`;
    } catch {
      return "(not a URL)";
    }
  }
  return value;
}

/** One line per setting that is set, with where its value came from; everything else is a built-in default. */
export function describeSettingSources(m: MergedEnv): string[] {
  const lines: string[] = [];
  for (const name of SETTING_NAMES) {
    const value = m.env[name];
    if (value === undefined || value.trim() === "") continue;
    lines.push(`  ${name.padEnd(30)} ${shownValue(name, value.trim()).padEnd(28)} from ${m.fromFile.has(name) ? m.file : "process environment"}`);
  }
  for (const name of m.overridden) lines.push(`  ${name.padEnd(30)} also in ${m.file}; the process environment wins`);
  return lines.length > 0 ? lines : ["  (none set: built-in defaults)"];
}

/** Prints what reflex would do with the current environment. Never prints secret values. */
export async function doctorCommand(io: LaunchIO & { stdout: (t: string) => void }): Promise<number> {
  const out = (line: string): void => io.stdout(`${line}\n`);
  out(`reflex ${packageVersion()} on node ${process.version} (${process.platform})`);

  const merged = mergeEnvFile(io.env, io.envFile, io.homedir);
  const fileLine =
    merged.state === "absent" ? "not present"
    : merged.state === "loaded" ? `loaded (${merged.fromFile.size} value${merged.fromFile.size === 1 ? "" : "s"} used)`
    : `NOT USED: ${merged.reason ?? merged.state}`;
  out(`env file:        ${merged.file} - ${fileLine}`);
  for (const w of merged.warnings) if (merged.reason === null || !w.includes(merged.reason)) out(`env file warning: ${w}`);
  out("settings (process environment over env file):");
  for (const line of describeSettingSources(merged)) out(line);
  const envProblem = merged.state === "refused" || merged.state === "unreadable";

  const loaded = loadConfig(merged.env, io.homedir);
  if (!loaded.ok) {
    for (const e of loaded.errors) out(`config error: ${e}`);
    return 1;
  }
  const c = loaded.config;
  for (const w of loaded.warnings) out(`config warning: ${w}`);
  out(`mode requested:  ${c.mode}`);
  out(`backend:         ${c.backend} (key ${c.typesafeApiKey ? "present" : merged.state === "refused" ? "missing: the env file was refused (see above)" : "missing"})`);
  out(`upstream:        ${new URL(c.upstreamUrl).origin}${new URL(c.upstreamUrl).pathname === "/" ? "" : new URL(c.upstreamUrl).pathname}`);
  out(`state directory: ${c.home}`);

  const bin = resolveClaude(c.claudeBin, realResolveIO(io.env));
  if (!bin) {
    out("claude:          NOT FOUND on PATH (set REFLEX_CLAUDE_BIN)");
    return 1;
  }
  const version = await probeClaudeVersion(bin, sanitizedEnv(io.env));
  const verdict = assessVersion(version, TESTED_CLAUDE_VERSIONS);
  out(`claude:          ${bin.path} (version ${version ?? "unknown"})`);
  out(`tested versions: ${TESTED_CLAUDE_VERSIONS.join(", ") || "none"}`);
  out(`version check:   ${verdict.level} (${verdict.reason})${describeVerdict(verdict) ? ` - ${describeVerdict(verdict)}` : ""}`);
  const eff = resolveEffectiveMode(c, verdict);
  out(`mode effective:  ${eff.mode}${eff.degradedReason ? ` (${eff.degradedReason})` : ""}`);
  return envProblem ? 1 : 0;
}
