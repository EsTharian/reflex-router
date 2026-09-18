import fs from "node:fs";
import { loadConfig } from "./config.js";
import { resolveEffectiveMode } from "./effective-mode.js";
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

/** Prints what reflex would do with the current environment. Never prints secret values. */
export async function doctorCommand(io: LaunchIO & { stdout: (t: string) => void }): Promise<number> {
  const out = (line: string): void => io.stdout(`${line}\n`);
  out(`reflex ${packageVersion()} on node ${process.version} (${process.platform})`);

  const loaded = loadConfig(io.env);
  if (!loaded.ok) {
    for (const e of loaded.errors) out(`config error: ${e}`);
    return 1;
  }
  const c = loaded.config;
  for (const w of loaded.warnings) out(`config warning: ${w}`);
  out(`mode requested:  ${c.mode}`);
  out(`backend:         ${c.backend} (key ${c.typesafeApiKey ? "present" : "missing"})`);
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
  return 0;
}
