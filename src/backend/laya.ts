// Laya over laya-serve (the Jev wire format), plus the feature questions and the calibration head of
// laya-calibration.ts. Without a calibration for the checkpoint (or with a question set it was not fitted for),
// Laya's own answers are returned unchanged.
import type { Decision, DecisionState, QuestionSet } from "../types.js";
import type { JevBackend } from "./jev.js";
import { CAL_TIERS, calibratedAnswers, FEATURE_QUESTIONS, FEATURE_VERSION, layaFeatures, type LayaCalibration } from "./laya-calibration.js";
import { BackendError, type DecisionBackend } from "./types.js";

/** Laya's decision together with the feature vector the calibration head reads (null when not computable). */
export interface LayaDecision {
  readonly decision: Decision;
  readonly features: number[] | null;
}

/** The head was fitted over exactly CAL_TIERS; any other offer (Fable allowed) gets Laya's raw answers. */
const fitsCalibration = (questions: QuestionSet): boolean => {
  const tier = questions["tier"];
  return tier?.type === "choice" && Object.keys(tier.criteria).join() === CAL_TIERS.join();
};

/** How long a decision keeps retrying a refused connection while laya-serve is still loading (see #ask). */
export const LAYA_LOAD_WAIT_MS = 30_000;
const RETRY_EVERY_MS = 250;

export class LayaBackend implements DecisionBackend {
  readonly id = "laya" as const;
  readonly #cal: LayaCalibration | undefined;

  constructor(
    private readonly inner: JevBackend,
    calibration: LayaCalibration | undefined,
    private readonly loadWaitMs = LAYA_LOAD_WAIT_MS,
  ) {
    // Parameters fitted for another feature layout would read the wrong numbers: ignore them.
    this.#cal = calibration?.featureVersion === FEATURE_VERSION ? calibration : undefined;
  }

  warm(): Promise<void> {
    return this.inner.warm();
  }

  close(): void {
    this.inner.close();
  }

  /**
   * laya-serve starts with the session and loads for seconds, and a session's first prompt (always, with `claude -p`)
   * arrives before it listens. A refused connection is therefore retried until loadWaitMs. In shadow mode the decision
   * is off the request's path; in route mode the router stops waiting at the decision deadline and the request goes out
   * unchanged, as for any late decision.
   */
  async #ask(state: DecisionState, questions: QuestionSet, opts: { readonly signal: AbortSignal }): Promise<Decision> {
    const until = Date.now() + this.loadWaitMs;
    for (;;) {
      try {
        return await this.inner.decide(state, questions, opts);
      } catch (e) {
        if (!(e instanceof BackendError && e.kind === "network") || Date.now() >= until || opts.signal.aborted) throw e;
        await new Promise((r) => setTimeout(r, RETRY_EVERY_MS));
      }
    }
  }

  /** Asks the product's questions and the feature questions in one call; answers are Laya's own. */
  async decideWithFeatures(state: DecisionState, questions: QuestionSet, opts: { readonly signal: AbortSignal }): Promise<LayaDecision> {
    const d = await this.#ask(state, { ...questions, ...FEATURE_QUESTIONS }, opts);
    const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, d.answers[id]!]));
    return { decision: { ...d, answers }, features: layaFeatures(d.answers, state) };
  }

  async decide(state: DecisionState, questions: QuestionSet, opts: { readonly signal: AbortSignal }): Promise<Decision> {
    const cal = this.#cal !== undefined && fitsCalibration(questions) ? this.#cal : undefined;
    if (cal === undefined) return this.#ask(state, questions, opts);
    const { decision, features } = await this.decideWithFeatures(state, questions, opts);
    if (features === null) throw new BackendError("invalid_response", "laya: incomplete answers for calibration");
    return { ...decision, answers: { ...decision.answers, ...calibratedAnswers(cal, features) }, backendModel: `${decision.backendModel}+${cal.version}` };
  }
}
