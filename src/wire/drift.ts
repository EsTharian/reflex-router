// Wire-format drift detection: a cheap, self-contained cross-check between two independent views of the same session.
//
// The hook stream says how many prompts the user typed. The classifier says how many main `new` turns it found. In a
// healthy session those track each other. When Claude Code 2.1.278 began sending typed prompts as a plain string
// instead of an array of blocks, they came apart completely — 10 typed prompts, one `new` turn — and nothing said so:
// every request forwarded correctly, every turn stayed pinned to the first decision, and the whole session routed
// nothing. The cost was invisible until the logs were read by hand a day later.
//
// It also flags values the fixtures never held: a requested model or a max_tokens value no capture contains (the
// 2.1.280 log's first sign of Opus 5.5 was a rewrite rejected for max_tokens 128000), and every rewrite the upstream
// rejected (`rewrite_rejected`, set by the router).
//
// This is an alarm, never a control. It does NOT degrade the session, does NOT gate routing and does NOT change any
// classification: the classifier's own fail-safe (an unrecognised shape stays `side` and forwards unchanged) already
// handles correctness. All this does is make the next format change visible on day one instead of a session later.
import type { RequestView } from "./claude-code.js";
import { FIXTURE_MAX_TOKENS, FIXTURE_REQUESTED_MODELS } from "./tested-versions.generated.js";

/** Typed prompts a session must have seen before the cross-check means anything. Below this, a quiet session looks the same. */
export const DRIFT_MIN_TYPED_PROMPTS = 3;
/** Main `new` turns at or below which that many typed prompts are not credible. One: the session's opening turn alone. */
export const DRIFT_MAX_NEW_TURNS = 1;

/** Logged as `drift` on the decision record and counted in report section 1. */
export type DriftReason = "typed_prompts_without_new_turns" | "unseen_requested_model" | "unseen_max_tokens" | "rewrite_rejected";

/**
 * Per-session counter. `observe` every classified request, then `check` it with the number of typed prompts the hook
 * stream has delivered for the session. Each reason is returned once per session (per distinct value for the unseen
 * ones), on the request that shows it.
 */
export class DriftTracker {
  #newTurns = 0;
  readonly #reported = new Set<string>();

  /** Main-chat `new` turns only: a subagent's first request is not the user typing. */
  observe(v: RequestView): void {
    if (v.kind === "main" && v.turn === "new") this.#newTurns++;
  }

  get newTurns(): number {
    return this.#newTurns;
  }

  /** The drift reasons to log on this request; empty when none is new for this session. */
  check(typedPromptCount: number, v: Pick<RequestView, "requestedModel" | "facts">): DriftReason[] {
    const out: DriftReason[] = [];
    const once = (key: string, r: DriftReason): void => {
      if (this.#reported.has(key)) return;
      this.#reported.add(key);
      out.push(r);
    };
    if (typedPromptCount >= DRIFT_MIN_TYPED_PROMPTS && this.#newTurns <= DRIFT_MAX_NEW_TURNS) once("typed", "typed_prompts_without_new_turns");
    if (v.requestedModel !== null && !FIXTURE_REQUESTED_MODELS.includes(v.requestedModel)) once(`model:${v.requestedModel}`, "unseen_requested_model");
    if (v.facts.maxTokens !== null && !FIXTURE_MAX_TOKENS.includes(v.facts.maxTokens)) once(`max:${v.facts.maxTokens}`, "unseen_max_tokens");
    return out;
  }
}
