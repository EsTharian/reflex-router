// `reflex share`: writes a structural-only copy of the decision log to a file, so calibration data can be sent back
// without sending anything about the work it came from.
//
// The rule this module exists to keep: it is an ALLOW-LIST, not a redactor. A field is copied only because it is named
// here, so a field added to the decision record in future is absent from a shared log until someone adds it
// deliberately. Everything else - prompt previews, error text, backend answers, file paths, task text - is dropped by
// never being named. Ids and conversation keys on the record are already hashes or random UUIDs.
//
// It writes a file and nothing else. There is no upload, no network call, and no code path in reflex that sends this
// file anywhere: the user attaches it themselves, or does not.
import fs from "node:fs";
import path from "node:path";
import { defaultHome } from "../config.js";
import { defaultLogFiles, parseDuration, readLogFiles } from "./records.js";

/** Top-level decision fields copied verbatim. Structural only: no text the user or the model wrote. */
export const SHARED_DECISION_FIELDS: readonly string[] = [
  "v", "record", "id", "at", "session", "conv", "kind", "signal", "turn", "side_kind", "side_marker",
  "unclassified_reason", "drift", "prompt_encoding", "mode_requested", "mode_effective", "degraded_reason",
  "claude_version", "cache_ttl_beta", "backend", "backend_version", "delegate_hint", "ab", "pin",
];
/** Outcome fields copied verbatim: counts, hashes, rule ids and runner kinds, which is all the record ever holds. */
export const SHARED_OUTCOME_FIELDS: readonly string[] = [
  "v", "record", "id", "at", "session", "decision_id", "turn_id", "turn_seq", "scope", "agent", "agent_type",
  "attribution", "parent_turn", "no_decision", "window", "counts", "signals", "params",
];

/** Fields that must NEVER appear in a shared log, asserted by test/unit/share.test.ts against a real record. */
export const NEVER_SHARED: readonly string[] = ["prompt_preview", "task", "sent", "error", "fallback_error", "side_fingerprint"];

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => typeof v === "object" && v !== null && !Array.isArray(v);
const pick = (o: unknown, keys: readonly string[]): J | null => (isObj(o) ? Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])) : null);

/** One shared record, or null when the record type is not shared at all. */
export function shareRecord(o: J): J | null {
  const kind = typeof o["record"] === "string" ? o["record"] : "decision";
  if (kind === "decision") {
    const d = o["decision"];
    const p = o["plan"];
    const tier = isObj(p) && isObj(p["target"]) ? p["target"]["tier"] : undefined;
    return {
      ...pick(o, SHARED_DECISION_FIELDS),
      signals: pick(o["signals"], ["header", "s1", "s2", "s3"]),
      requested: pick(o["requested"], ["model", "tier", "effort"]),
      // Only that the backend answered, its readings, and how long it took. Never what was sent to it.
      decision: isObj(d)
        ? {
            picks: { tier: pick(isObj(d["picks"]) ? d["picks"]["tier"] : null, ["value", "confidence", "probabilities"]) },
            ...pick(d, ["rule", "pick_mass", "pick_argmax", "vetoes", "latencyMs", "tokensIn", "backendModel", "connection"]),
          }
        : null,
      plan: isObj(p) ? { target: typeof tier === "string" ? { tier } : null, ...pick(p, ["reasons", "would_upgrade"]) } : null,
      guard: pick(o["guard"], ["allowed", "reason", "ctx", "penalty_usd"]),
      escalation: pick(o["escalation"], ["signal", "from", "to", "decision_id", "turn_seq"]),
      would_escalate: pick(o["would_escalate"], ["signal", "from", "to", "decision_id", "turn_seq"]),
      forwarded: pick(o["forwarded"], ["requested_model", "model", "rewritten", "fields", "fallback", "fallback_status"]),
      upstream: pick(o["upstream"], ["status", "msToHeaders"]),
      timing: pick(o["timing"], ["decision_wait_ms", "decision_deadline_ms", "upstream_first_byte_ms"]),
      usage: pick(o["usage"], ["input", "output", "cache_read", "cache_create"]),
    };
  }
  if (kind === "outcome") return pick(o, SHARED_OUTCOME_FIELDS);
  if (kind === "outcome_update") return pick(o, ["v", "record", "id", "at", "session", "decision_id", "turn_id", "turn_seq", "scope", "agent", "signal", "detail"]);
  if (kind === "harness_injected") return pick(o, ["v", "record", "id", "at", "session", "decision_id", "conv", "reason"]);
  if (kind === "delegate_hint") return pick(o, ["v", "record", "id", "at", "session", "version"]);
  return null; // an unknown record type is dropped, not guessed at
}

export interface ShareResult {
  readonly lines: string[];
  readonly counts: Readonly<Record<string, number>>;
  readonly dropped: number;
  readonly skippedLines: number;
}

/** Pure: JSONL text in, shared JSONL lines out. */
export function buildShare(texts: readonly string[], fromMs: number | null): ShareResult {
  const lines: string[] = [];
  const counts: Record<string, number> = {};
  let dropped = 0;
  let skippedLines = 0;
  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        skippedLines++;
        continue;
      }
      if (!isObj(o)) {
        skippedLines++;
        continue;
      }
      if (fromMs !== null) {
        const at = typeof o["at"] === "string" ? Date.parse(o["at"]) : NaN;
        if (Number.isNaN(at) || at < fromMs) continue;
      }
      const shared = shareRecord(o);
      if (shared === null) {
        dropped++;
        continue;
      }
      const kind = typeof o["record"] === "string" ? o["record"] : "decision";
      counts[kind] = (counts[kind] ?? 0) + 1;
      lines.push(JSON.stringify(shared));
    }
  }
  return { lines, counts, dropped, skippedLines };
}

export interface ShareIO {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (t: string) => void;
  readonly stderr: (t: string) => void;
}

const USAGE = "usage: reflex share [--since <2h|30m|7d>] [--out <file.jsonl>] [<decisions.jsonl> ...]\n";

/** Exit code: 0 ok, 2 bad arguments, 1 unreadable input or unwritable output. */
export function shareCommand(args: readonly string[], io: ShareIO): number {
  let sinceText: string | undefined;
  let outFile: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--since" || a.startsWith("--since=")) {
      const v = a === "--since" ? args[++i] : a.slice("--since=".length);
      if (v === undefined || parseDuration(v) === null) {
        io.stderr(`reflex share: --since needs a duration like 90s, 30m, 2h or 7d\n${USAGE}`);
        return 2;
      }
      sinceText = v;
    } else if (a === "--out" || a.startsWith("--out=")) {
      const v = a === "--out" ? args[++i] : a.slice("--out=".length);
      if (v === undefined || v === "") {
        io.stderr(`reflex share: --out needs a file path\n${USAGE}`);
        return 2;
      }
      outFile = v;
    } else if (a === "--help" || a === "-h") {
      io.stdout(USAGE);
      return 0;
    } else if (a.startsWith("-")) {
      io.stderr(`reflex share: unknown option ${a}\n${USAGE}`);
      return 2;
    } else files.push(a);
  }

  const home = defaultHome(io.env);
  const sources = files.length > 0 ? files : defaultLogFiles(home);
  if (sources.length === 0) {
    io.stderr(`reflex share: no decision log at ${home}/decisions.jsonl yet (run reflex in shadow or route mode first)\n`);
    return 1;
  }
  let texts;
  try {
    texts = readLogFiles(sources);
  } catch (e) {
    io.stderr(`reflex share: cannot read ${(e as NodeJS.ErrnoException).path ?? "the log"} (${(e as NodeJS.ErrnoException).code ?? "error"})\n`);
    return 1;
  }
  const since = sinceText === undefined ? null : parseDuration(sinceText);
  const fromMs = since === null ? null : Date.now() - since;
  const result = buildShare(texts.map((t) => t.text), fromMs);
  const target = outFile ?? path.join(home, `reflex-share-${new Date().toISOString().slice(0, 10)}.jsonl`);
  try {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(target, result.lines.join("\n") + (result.lines.length > 0 ? "\n" : ""), { mode: 0o600 });
  } catch (e) {
    io.stderr(`reflex share: cannot write ${target} (${(e as NodeJS.ErrnoException).code ?? "error"})\n`);
    return 1;
  }

  io.stdout(describeShare(result, target, sources, sinceText));
  return 0;
}

/** Exactly what the file contains and what it cannot contain. Printed every time, not behind a flag. */
export function describeShare(result: ShareResult, target: string, sources: readonly string[], sinceText: string | undefined): string {
  const kinds = Object.entries(result.counts).sort(([a], [b]) => a.localeCompare(b));
  const lines = [
    `reflex share -> ${target}`,
    `  read: ${sources.join(", ")}${sinceText === undefined ? "" : ` (--since ${sinceText})`}`,
    `  wrote ${result.lines.length} records: ${kinds.length === 0 ? "none" : kinds.map(([k, n]) => `${k} ${n}`).join(", ")}`,
  ];
  if (result.dropped > 0) lines.push(`  dropped ${result.dropped} record(s) of a type this version does not share`);
  if (result.skippedLines > 0) lines.push(`  skipped ${result.skippedLines} line(s) that were not JSON objects`);
  lines.push(
    "",
    "  What this file contains, in full:",
    "    - hashed session and conversation ids, and the record ids reflex generates (random UUIDs)",
    "    - timestamps, tiers and model names, which tier was picked and which was sent, and why (reason codes)",
    "    - the backend's own answer: probabilities, confidence, rule, latency, and its version",
    "    - token counts, HTTP status codes and timings",
    "    - outcome counts (edits, bash runs, test runs), correction RULE IDS and scores, and test-runner kinds",
    "",
    "  What it cannot contain, because those fields are never copied:",
    "    - any prompt, any reply, any code, any command text, any file path (hashed or not, they are simply not copied)",
    "    - your Anthropic credentials or your TypeSafe key, which reflex never records anywhere",
    "    - your machine name, your user name, your working directory, or any environment variable",
    "",
    "  reflex sent nothing. This command writes a file and makes no network connection of any kind;",
    "  there is no telemetry in reflex and no code path that uploads this. Read it yourself before you share it:",
    `    head -3 ${target}`,
    "  Where to send it, if you want to: see \"Contributing data\" in the README.",
  );
  return lines.join("\n") + "\n";
}
