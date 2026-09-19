// `reflex report`: reads the decision log (JSONL files only, no network) and prints its sections.
import { defaultHome } from "../config.js";
import { fingerprintGroups, SECTIONS, type Ctx } from "./sections.js";
import { defaultLogFiles, parseDuration, parseRecords, readLogFiles, sinceView, type Records } from "./records.js";

export interface ReportOptions {
  readonly usd: boolean;
  /** Only records at or after this time (ms since epoch). */
  readonly fromMs?: number;
  /** Text shown in the header for the filter, e.g. `2h`. */
  readonly sinceText?: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The whole report as text. Pure: `all` is what the files held, filtering by time happens here. */
export function buildReport(all: Records, opts: ReportOptions): string {
  const rec = opts.fromMs === undefined ? all : sinceView(all, opts.fromMs);
  const ctx: Ctx = { rec, byId: new Map(all.decisions.map((d) => [d.id, d])), usd: opts.usd };
  const times = [...rec.decisions.map((d) => d.atMs), ...rec.outcomes.map((o) => o.atMs)];
  const span = times.length === 0 ? "no records" : `${iso(Math.min(...times))} .. ${iso(Math.max(...times))}`;
  const sessions = new Set(rec.decisions.map((d) => d.session ?? "?")).size;
  const lines = [
    "reflex report",
    `  files: ${all.sources.length === 0 ? "(none)" : all.sources.join(", ")}`,
    `  records in range: ${rec.decisions.length} decisions, ${rec.outcomes.length} outcomes, ${rec.updates.length} outcome updates, ${rec.harnessInjected.length} harness_injected${rec.hints.length > 0 ? `, ${rec.hints.length} delegate_hint` : ""}${rec.decisions.length > 0 ? `, ${sessions} session${sessions === 1 ? "" : "s"}` : ""}`,
    `  span: ${span}${opts.sinceText ? ` (--since ${opts.sinceText})` : ""}`,
    ...(all.unterminatedLines === 0
      ? all.skippedLines > 0 ? [`  skipped ${all.skippedLines} line(s) that are not valid records`] : []
      : [`  skipped ${all.skippedLines} line(s): ${all.skippedLines - all.unterminatedLines} not valid records, ${all.unterminatedLines} unterminated last line(s) (still being written; the next report has it)`]),
    ...(all.other > 0 ? [`  ${all.other} record(s) of an unknown type ignored`] : []),
    "  Every figure below is computed from these records only; small samples are marked, and none of it is a benchmark (see docs/observations.md).",
  ];
  for (const s of SECTIONS) lines.push("", s.title, ...s.run(ctx));
  return lines.join("\n") + "\n";
}

/** `--fingerprints`: one JSON object per distinct unclassified side-call fingerprint, and nothing else. */
export function buildFingerprints(all: Records, opts: Pick<ReportOptions, "fromMs">): string {
  const rec = opts.fromMs === undefined ? all : sinceView(all, opts.fromMs);
  return fingerprintGroups(rec.decisions.filter((d) => d.turn === "side" && d.sideKind === "unclassified")).map((g) => JSON.stringify(g) + "\n").join("");
}

export interface ReportIO {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (t: string) => void;
  readonly stderr: (t: string) => void;
  readonly now?: () => number;
}

const USAGE = "usage: reflex report [--since <2h|30m|7d>] [--usd | --fingerprints] [<decisions.jsonl> ...]\n";

/** Exit code: 0 ok, 2 bad arguments, 1 unreadable input. */
export function reportCommand(args: readonly string[], io: ReportIO): number {
  let usd = false;
  let fingerprints = false;
  let sinceText: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--usd") usd = true;
    else if (a === "--fingerprints") fingerprints = true;
    else if (a === "--since" || a.startsWith("--since=")) {
      const v = a === "--since" ? args[++i] : a.slice("--since=".length);
      if (v === undefined || parseDuration(v) === null) {
        io.stderr(`reflex report: --since needs a duration like 90s, 30m, 2h or 7d\n${USAGE}`);
        return 2;
      }
      sinceText = v;
    } else if (a === "--help" || a === "-h") {
      io.stdout(USAGE);
      return 0;
    } else if (a.startsWith("-")) {
      io.stderr(`reflex report: unknown option ${a}\n${USAGE}`);
      return 2;
    } else files.push(a);
  }
  const home = defaultHome(io.env);
  const sources = files.length > 0 ? files : defaultLogFiles(home);
  let texts;
  try {
    texts = readLogFiles(sources);
  } catch (e) {
    io.stderr(`reflex report: cannot read ${(e as NodeJS.ErrnoException).path ?? "the log"} (${(e as NodeJS.ErrnoException).code ?? "error"})\n`);
    return 1;
  }
  if (files.length === 0 && sources.length === 0) io.stderr(`reflex report: no decision log at ${home}/decisions.jsonl yet (run reflex in shadow or route mode first)\n`);
  const fromMs = sinceText === undefined ? undefined : (io.now ?? Date.now)() - parseDuration(sinceText)!;
  if (fingerprints) {
    io.stdout(buildFingerprints(parseRecords(texts), fromMs !== undefined ? { fromMs } : {}));
    return 0;
  }
  io.stdout(buildReport(parseRecords(texts), { usd, ...(fromMs !== undefined ? { fromMs } : {}), ...(sinceText !== undefined ? { sinceText } : {}) }));
  return 0;
}
