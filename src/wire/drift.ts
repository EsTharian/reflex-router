// Wire-format drift detection: a cheap, self-contained cross-check between two independent views of the same session.
//
// The hook stream says how many prompts the user typed. The classifier says how many main `new` turns it found. In a
// healthy session those track each other. When Claude Code 2.1.278 began sending typed prompts as a plain string
// instead of an array of blocks, they came apart completely — 10 typed prompts, one `new` turn — and nothing said so:
// every request forwarded correctly, every turn stayed pinned to the first decision, and the whole session routed
// nothing. The cost was invisible until the logs were read by hand a day later.
//
// This is an alarm, never a control. It does NOT degrade the session, does NOT gate routing and does NOT change any
// classification: the classifier's own fail-safe (an unrecognised shape stays `side` and forwards unchanged) already
// handles correctness. All this does is make the next format change visible on day one instead of a session later.
import type { RequestView } from "./claude-code.js";

/** Typed prompts a session must have seen before the cross-check means anything. Below this, a quiet session looks the same. */
export const DRIFT_MIN_TYPED_PROMPTS = 3;
/** Main `new` turns at or below which that many typed prompts are not credible. One: the session's opening turn alone. */
export const DRIFT_MAX_NEW_TURNS = 1;

/** Logged as `drift` on the decision record and counted in report section 1. */
export type DriftReason = "typed_prompts_without_new_turns";

/**
 * Per-session counter. `observe` every classified request, then `check` with the number of typed prompts the hook
 * stream has delivered for the session; the reason is returned once, on the request that crosses the threshold.
 */
export class DriftTracker {
  #newTurns = 0;
  #reported = false;

  /** Main-chat `new` turns only: a subagent's first request is not the user typing. */
  observe(v: RequestView): void {
    if (v.kind === "main" && v.turn === "new") this.#newTurns++;
  }

  get newTurns(): number {
    return this.#newTurns;
  }

  /** The drift reason to log on this request, or null. Returns non-null at most once per session. */
  check(typedPromptCount: number): DriftReason | null {
    if (this.#reported) return null;
    if (typedPromptCount < DRIFT_MIN_TYPED_PROMPTS || this.#newTurns > DRIFT_MAX_NEW_TURNS) return null;
    this.#reported = true;
    return "typed_prompts_without_new_turns";
  }
}
