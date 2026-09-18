import type { Decision } from "../types.js";
import { BackendError, type DecisionBackend } from "./types.js";

/** Placeholder for a local logit-reading backend. The launcher already runs `REFLEX_BACKEND=local` as passthrough. */
export class LocalBackend implements DecisionBackend {
  readonly id = "local" as const;
  decide(): Promise<Decision> {
    return Promise.reject(new BackendError("not_implemented", "REFLEX_BACKEND=local is not implemented yet (TODO: local logit-reading backend)"));
  }
}
