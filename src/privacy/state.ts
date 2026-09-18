// Builds the only thing a decision backend ever sees. Truncate first, then redact, then assemble from an explicit
// allow-list of keys: task, previous_assistant_reply, context{requesting_tier, is_subagent}. No paths, tool lists,
// session ids, headers or system prompt.
import type { Config } from "../config.js";
import { tierOfModel } from "../tiers.js";
import type { DecisionState } from "../types.js";
import { headTail, tail } from "./budget.js";
import { redact } from "./redact.js";

export interface StateInput {
  readonly kind: "main" | "subagent";
  readonly task: string;
  readonly previousAssistantText: string | null;
  readonly requestedModel: string | null;
}

export interface BuiltState {
  readonly state: DecisionState;
  /** Logged: which top-level keys were sent and how many characters of text. */
  readonly sent: { readonly keys: readonly string[]; readonly chars: number };
}

export function buildState(input: StateInput, cfg: Pick<Config, "maxUserChars" | "maxAssistantChars">): BuiltState {
  const task = redact(headTail(input.task, cfg.maxUserChars));
  const prev = input.kind === "main" && input.previousAssistantText && cfg.maxAssistantChars > 0 ? redact(tail(input.previousAssistantText, cfg.maxAssistantChars)) : null;
  const context = { requesting_tier: tierOfModel(input.requestedModel) ?? ("unknown" as const), is_subagent: input.kind === "subagent" };
  const state: DecisionState = prev !== null ? { task, previous_assistant_reply: prev, context } : { task, context };
  return { state, sent: { keys: Object.keys(state), chars: task.length + (prev?.length ?? 0) } };
}
