import { spawn } from "node:child_process";
import type { ResolvedBin } from "./claude-bin.js";

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export type VersionLevel = "ok" | "warn" | "degrade";
export type VersionReason = "exact_match" | "unparseable" | "no_tested_versions" | "minor_mismatch" | "major_mismatch";

export interface VersionVerdict {
  readonly level: VersionLevel;
  readonly reason: VersionReason;
  readonly running: string | null;
  readonly tested: readonly string[];
}

/** First MAJOR.MINOR.PATCH in the text ("2.1.277 (Claude Code)" -> 2.1.277), or null. */
export function parseVersion(text: string | null | undefined): ParsedVersion | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

const sameTriple = (a: ParsedVersion, b: ParsedVersion): boolean => a.major === b.major && a.minor === b.minor && a.patch === b.patch;

/**
 * The version is only a HINT about whether the wire-format contract we captured still holds
 * (the worker verifies the actual shape at runtime). So:
 *   exact match with a tested version   -> ok
 *   same major, other minor/patch       -> warn
 *   unparseable / nothing to compare    -> warn (we do not degrade on a hint we cannot read)
 *   different major from every tested   -> degrade (route becomes shadow)
 */
export function assessVersion(running: string | null, tested: readonly string[]): VersionVerdict {
  const base = { running, tested };
  const run = parseVersion(running);
  const known = tested.map(parseVersion).filter((v): v is ParsedVersion => v !== null);
  if (run === null) return { ...base, level: "warn", reason: "unparseable" };
  if (known.length === 0) return { ...base, level: "warn", reason: "no_tested_versions" };
  if (known.some((t) => sameTriple(t, run))) return { ...base, level: "ok", reason: "exact_match" };
  if (known.some((t) => t.major === run.major)) return { ...base, level: "warn", reason: "minor_mismatch" };
  return { ...base, level: "degrade", reason: "major_mismatch" };
}

/** "2.1.277 (Claude Code)" -> "2.1.277"; falls back to the raw text. */
function shownVersion(running: string | null): string {
  const p = parseVersion(running);
  return p ? `${p.major}.${p.minor}.${p.patch}` : (running ?? "?");
}

/** One-line, human-readable explanation; null when there is nothing to say. */
export function describeVerdict(v: VersionVerdict): string | null {
  const tested = v.tested.length > 0 ? v.tested.join(", ") : "none";
  const running = shownVersion(v.running);
  switch (v.reason) {
    case "exact_match":
      return null;
    case "minor_mismatch":
      return `Claude Code ${running} differs from the tested version(s) ${tested}; routing signals may have drifted (see \`reflex doctor\`)`;
    case "major_mismatch":
      return `Claude Code ${running} has a different major version than the tested one(s) ${tested}; decisions are only recorded, never applied`;
    case "unparseable":
      return "could not determine the Claude Code version; relying on runtime shape checks only";
    case "no_tested_versions":
      return "no tested Claude Code versions are recorded; relying on runtime shape checks only";
  }
}

/** Runs `claude --version`; null when it cannot be determined within the timeout. Never throws. */
export function probeClaudeVersion(bin: ResolvedBin, env: NodeJS.ProcessEnv, timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      child = spawn(bin.path, ["--version"], { env, stdio: ["ignore", "pipe", "ignore"], shell: bin.needsShell });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 ? (out.split("\n")[0]?.trim() ?? null) || null : null));
  });
}
