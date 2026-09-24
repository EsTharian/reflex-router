// The http hooks reflex injects into Claude Code (via the one merged --settings file) to capture outcomes.
// Tool events are limited to the tools outcome capture reads, so other tool calls (Read, Grep, ...) cost nothing;
// PreToolUse only for the Agent tool, whose title the status line shows next to the subagent.
import type { HookGroup } from "../launcher/settings-inject.js";
import { AGENT_TOOLS, OBSERVED_TOOLS } from "./hooks.js";

export const HOOK_PATH = "/__reflex/hook";
/** Seconds Claude Code waits for our endpoint; failures and timeouts are non-blocking for http hooks. */
export const HOOK_TIMEOUT_S = 2;
export const HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop", "Stop"] as const;

export function outcomeHooks(port: number): Record<string, readonly HookGroup[]> {
  const hook = { type: "http", url: `http://127.0.0.1:${port}${HOOK_PATH}`, timeout: HOOK_TIMEOUT_S };
  const matcher = (e: string): string | null => (e === "PostToolUse" || e === "PostToolUseFailure" ? OBSERVED_TOOLS.join("|") : e === "PreToolUse" ? AGENT_TOOLS.join("|") : null);
  return Object.fromEntries(HOOK_EVENTS.map((e) => { const m = matcher(e); return [e, [m === null ? { hooks: [hook] } : { matcher: m, hooks: [hook] }]]; }));
}
