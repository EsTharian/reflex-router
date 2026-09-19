// The hook side of REFLEX_DELEGATE: which UserPromptSubmit events get the hint, and the response body that carries it.
// Only user-typed main-chat prompts qualify (src/wire decides what Claude Code injected itself); everything else, and
// any failure, gets no body, which Claude Code treats as "no hook output". Nothing here can block or change a prompt:
// the body only ever holds `hookSpecificOutput.additionalContext`.
import type { HookEvent } from "../outcome/hooks.js";
import { isTypedPrompt } from "../wire/claude-code.js";
import { HINT_TEXT } from "./hint.js";

/** The JSON body to answer this hook event with, or null for "no output". Never throws. */
export function hintReply(event: HookEvent | null): Buffer | null {
  try {
    if (event?.type !== "UserPromptSubmit" || event.base.agentId !== null || !isTypedPrompt(event.prompt)) return null;
    return Buffer.from(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: HINT_TEXT } }));
  } catch {
    return null;
  }
}
