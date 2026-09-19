// The http hooks reflex injects into Claude Code (via the one merged --settings file) to capture outcomes.
// Tool events are limited to the tools outcome capture reads, so other tool calls (Read, Grep, ...) cost nothing.
import type { HookGroup } from "../launcher/settings-inject.js";
import { OBSERVED_TOOLS } from "./hooks.js";

export const HOOK_PATH = "/__reflex/hook";
/** Seconds Claude Code waits for our endpoint; failures and timeouts are non-blocking for http hooks. */
export const HOOK_TIMEOUT_S = 2;
export const HOOK_EVENTS = ["UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop", "Stop"] as const;

export function outcomeHooks(port: number): Record<string, readonly HookGroup[]> {
  const hook = { type: "http", url: `http://127.0.0.1:${port}${HOOK_PATH}`, timeout: HOOK_TIMEOUT_S };
  const toolMatcher = OBSERVED_TOOLS.join("|");
  return Object.fromEntries(HOOK_EVENTS.map((e) => [e, [e === "PostToolUse" || e === "PostToolUseFailure" ? { matcher: toolMatcher, hooks: [hook] } : { hooks: [hook] }]]));
}
