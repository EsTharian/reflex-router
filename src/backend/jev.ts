// TypeSafe Jev (System One) over raw fetch: POST {base}/v1/systemone, Bearer key, {state, model, questions}.
// Zero retries (an SDK's default retries would add seconds), a hard deadline, and strict validation: any odd or
// partial answer is an error, so the caller fails open. Error messages never include the response body or the key.
import type { Answer, Decision, DecisionState, QuestionSet } from "../types.js";
import { BackendError, type DecisionBackend } from "./types.js";

export const JEV_MODEL = "jev-latest";
export const JEV_PATH = "/v1/systemone";
/** Probabilities must sum to 1 within this tolerance. */
const SUM_TOLERANCE = 0.02;

export interface JevOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly model?: string;
  /** Injectable for tests. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isUnit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function probabilities(v: unknown, keys: readonly string[], what: string): Record<string, number> {
  if (!isObj(v)) throw new BackendError("invalid_response", `${what}: probabilities missing`);
  const out: Record<string, number> = {};
  let sum = 0;
  for (const [k, p] of Object.entries(v)) {
    if (!keys.includes(k)) throw new BackendError("invalid_response", `${what}: probability for an unknown option`);
    if (!isUnit(p)) throw new BackendError("invalid_response", `${what}: probability out of range`);
    out[k] = p;
    sum += p;
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE) throw new BackendError("invalid_response", `${what}: probabilities do not sum to 1`);
  return out;
}

/** Validates one answer against the question that was asked. */
export function validateAnswer(id: string, q: QuestionSet[string], a: unknown): Answer {
  if (!isObj(a) || a["type"] !== q.type) throw new BackendError("invalid_response", `${id}: answer type does not match the question`);
  switch (q.type) {
    case "choice": {
      const options = Object.keys(q.criteria);
      const choice = a["choice"];
      if (typeof choice !== "string" || !options.includes(choice)) throw new BackendError("invalid_response", `${id}: choice is not one of the options`);
      if (!isUnit(a["confidence"])) throw new BackendError("invalid_response", `${id}: confidence out of range`);
      return { type: "choice", choice, confidence: a["confidence"], probabilities: probabilities(a["probabilities"], options, id) };
    }
    case "score": {
      const levels = q.criteria.map((_, i) => String(i));
      const score = a["score"];
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > levels.length - 1) throw new BackendError("invalid_response", `${id}: score out of range`);
      if (!isUnit(a["confidence"])) throw new BackendError("invalid_response", `${id}: confidence out of range`);
      return { type: "score", score, confidence: a["confidence"], probabilities: probabilities(a["probabilities"], levels, id) };
    }
    case "noul": {
      if (!isUnit(a["noul"])) throw new BackendError("invalid_response", `${id}: noul out of range`);
      return { type: "noul", p: a["noul"] };
    }
  }
}

export class JevBackend implements DecisionBackend {
  readonly id = "jev" as const;
  readonly #url: string;

  constructor(private readonly opts: JevOptions) {
    this.#url = opts.baseUrl.replace(/\/+$/, "") + JEV_PATH;
  }

  async decide(state: DecisionState, questions: QuestionSet, { signal }: { readonly signal: AbortSignal }): Promise<Decision> {
    const now = this.opts.now ?? Date.now;
    const started = now();
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, this.opts.timeoutMs);
    const onAbort = (): void => ac.abort();
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onAbort, { once: true });

    try {
      let res: Response;
      try {
        res = await (this.opts.fetch ?? fetch)(this.#url, {
          method: "POST",
          headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ state, model: this.opts.model ?? JEV_MODEL, questions }),
          signal: ac.signal,
        });
      } catch {
        if (timedOut) throw new BackendError("timeout", `no answer within ${this.opts.timeoutMs} ms`);
        if (signal.aborted) throw new BackendError("aborted", "aborted by caller");
        throw new BackendError("network", "request failed");
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined); // the error body is never read or logged
        throw new BackendError("http", `HTTP ${res.status}`, res.status);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        if (timedOut) throw new BackendError("timeout", `no answer within ${this.opts.timeoutMs} ms`);
        throw new BackendError("invalid_response", "response is not JSON");
      }
      if (!isObj(body) || !isObj(body["answers"])) throw new BackendError("invalid_response", "answers missing");
      const raw = body["answers"];
      const answers: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(questions)) answers[id] = validateAnswer(id, q, raw[id]);
      const usage = body["usage"];
      const tokensIn = isObj(usage) && typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : null;
      const backendModel = typeof body["model"] === "string" ? body["model"] : (this.opts.model ?? JEV_MODEL);
      return { answers, latencyMs: now() - started, backendModel, tokensIn };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
