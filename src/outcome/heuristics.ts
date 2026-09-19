// Outcome heuristics (pure). They produce signal STRENGTHS and matched rule ids for Phase 2 to tune against, never
// verdicts. Every threshold and weight is a named constant here. Text passed in is never stored by these functions.

/** Only the start of the next prompt is examined: corrections are stated up front. */
export const CORRECTION_WINDOW_CHARS = 300;
/** A short follow-up that already matched something is a stronger correction signal. */
export const SHORT_PROMPT_CHARS = 80;
export const SHORT_PROMPT_BOOST = 1.25;
export const CORRECTION_SCORE_CAP = 3;
/** A later edit undoing an earlier one counts when it happens within this many user turns (0 = same turn). */
export const REVERT_WINDOW_TURNS = 3;

/** A whole-word match that also works for non-ASCII letters (Turkish ı, ş, ğ, ...). */
const word = (w: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, "iu");
const start = (w: string): RegExp => new RegExp(`^\\s*${w}(?![\\p{L}\\p{N}])`, "iu");

interface Rule {
  readonly id: string;
  readonly re: RegExp;
  readonly weight: number;
}

/** English and Turkish phrasings of "that was wrong / not what I wanted / undo it". Coverage is a stated limitation. */
export const CORRECTION_RULES: readonly Rule[] = [
  { id: "en:starts_no", re: start("(no|nope|wrong)"), weight: 1.0 },
  { id: "en:thats_wrong", re: word("that'?s (wrong|not (it|right|correct|what i (asked|wanted|meant)))"), weight: 1.0 },
  { id: "en:not_what_i_asked", re: word("not what i (asked|meant|wanted|said)"), weight: 1.0 },
  { id: "en:undo", re: word("(undo|revert|roll ?back|put it back)"), weight: 0.8 },
  { id: "en:still_failing", re: word("(still|again) (fail(s|ing)?|broken|wrong|not working|doesn'?t work)"), weight: 0.8 },
  { id: "en:you_broke", re: word("you (broke|missed|forgot|ignored|didn'?t)"), weight: 0.8 },
  { id: "en:doesnt_work", re: word("(doesn'?t|does not|didn'?t|isn'?t|is not) work(ing)?"), weight: 0.7 },
  { id: "en:i_said", re: word("i (said|asked|told you)"), weight: 0.7 },
  { id: "en:try_again", re: word("try (again|once more)"), weight: 0.6 },
  { id: "en:incorrect", re: word("(incorrect|that is wrong|wrong file|wrong place)"), weight: 0.6 },
  { id: "en:why_did_you", re: word("why (did|would) you"), weight: 0.6 },
  { id: "tr:starts_no", re: start("(hayır|yok|olmaz)"), weight: 1.0 },
  { id: "tr:wrong", re: word("yanlış"), weight: 0.8 },
  { id: "tr:didnt_work", re: word("(olmadı|çalışmıyor|çalışmadı|bozdun|bozuldu)"), weight: 0.8 },
  { id: "tr:undo", re: word("(geri al|eski haline|geri döndür)"), weight: 0.8 },
  { id: "tr:not_what_i_said", re: word("(demedim|istemedim|öyle değil|bunu değil)"), weight: 0.8 },
  { id: "tr:fix_it", re: word("düzelt"), weight: 0.5 },
  { id: "tr:still", re: word("(hala|hâlâ)"), weight: 0.4 },
];

export interface CorrectionSignal {
  /** Summed rule weights (short-prompt boost applied), capped. 0 = nothing matched. */
  readonly score: number;
  /** Ids of the rules that matched; never the text itself. */
  readonly matched: readonly string[];
  readonly promptChars: number;
}

export function correctionSignal(nextPrompt: string): CorrectionSignal {
  const head = Array.from(nextPrompt).slice(0, CORRECTION_WINDOW_CHARS).join("");
  const matched = CORRECTION_RULES.filter((r) => r.re.test(head));
  let score = matched.reduce((s, r) => s + r.weight, 0);
  if (score > 0 && nextPrompt.trim().length <= SHORT_PROMPT_CHARS) score *= SHORT_PROMPT_BOOST;
  return { score: Math.round(Math.min(score, CORRECTION_SCORE_CAP) * 100) / 100, matched: matched.map((r) => r.id), promptChars: nextPrompt.length };
}

/** Test, build and type-check runners. Returns a short kind for the log (never the full command), or null. */
const TEST_RUNNERS: readonly [string, RegExp][] = [
  ["npm-test", /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|t|check|typecheck)\b/],
  ["node-test", /\bnode\s+(--test\b|[^\s]*run-tests)/],
  ["vitest", /\bvitest\b/],
  ["jest", /\bjest\b/],
  ["mocha", /\bmocha\b/],
  ["tsc", /\btsc\b/],
  ["pytest", /\b(pytest|py\.test)\b|\bpython3?\s+-m\s+(pytest|unittest)\b/],
  ["go-test", /\bgo\s+(test|vet)\b/],
  ["cargo-test", /\bcargo\s+(test|check|clippy)\b/],
  ["jvm-test", /\b(mvn|gradle|gradlew)\b.*\b(test|check|verify)\b/],
  ["make-test", /\bmake\s+(test|check)\b/],
  ["rspec", /\b(rspec|rake\s+test)\b/],
  ["phpunit", /\bphpunit\b/],
  ["dotnet-test", /\bdotnet\s+test\b/],
];
export function testRunnerKind(command: string): string | null {
  for (const [kind, re] of TEST_RUNNERS) if (re.test(command)) return kind;
  return null;
}

/** "Exit code 1\n..." (PostToolUseFailure.error, observed on 2.1.277) -> 1; null when absent. */
export function exitCode(error: string | null | undefined): number | null {
  const m = /Exit code (\d+)/.exec(error ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * Files a git command puts back to their committed state, per `&&`/`;`-separated segment:
 *   git reset --hard | git stash [push|save] | git checkout . | git restore .   -> "*" (the whole tree)
 *   git restore <paths> (not --staged alone) | git checkout -- <paths>         -> those paths
 *   git checkout <arg> (no --)                                                  -> <arg> only if it looks like a file
 *                                                                                  (has "/" or "."), else a branch switch
 */
export function gitRestoredPaths(command: string): readonly string[] {
  const out: string[] = [];
  for (const segment of command.split(/&&|;|\|\|/)) {
    const words = segment.trim().split(/\s+/);
    if (words[0] !== "git") continue;
    const [sub, ...rest] = words.slice(1);
    const flags = rest.filter((w) => w.startsWith("-"));
    const dashDash = rest.indexOf("--");
    const args = (dashDash >= 0 ? rest.slice(dashDash + 1) : rest).filter((w) => !w.startsWith("-"));
    if ((sub === "reset" && flags.includes("--hard")) || (sub === "stash" && (args.length === 0 || ["push", "save"].includes(args[0]!)))) out.push("*");
    else if (sub === "restore" && !(flags.includes("--staged") && !flags.includes("--worktree"))) out.push(...(args.includes(".") ? ["*"] : args));
    else if (sub === "checkout" && dashDash >= 0) out.push(...(args.includes(".") ? ["*"] : args));
    else if (sub === "checkout") out.push(...args.filter((a) => a === "." || a.includes("/") || a.includes(".")).map((a) => (a === "." ? "*" : a)));
  }
  return out;
}

/** True when `restored` (from gitRestoredPaths) covers `file` (absolute or cwd-relative path). */
export function coversFile(restored: readonly string[], file: string): boolean {
  return restored.some((r) => r === "*" || file === r || file.endsWith(`/${r.replace(/^\.\//, "")}`));
}
