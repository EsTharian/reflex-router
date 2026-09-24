// Claude Code hook payloads (documented contract, code.claude.com/docs/en/hooks.md; field names verified on the
// 2.1.277 fixtures test/fixtures/claude-code/2.1.277/*.hooks.jsonl). Only the fields outcome capture uses are read.
// Parsing never throws; an event it cannot use is null. Hook text (prompts, file contents) is used in memory only.

export type HookEvent =
  | { readonly type: "UserPromptSubmit"; readonly base: Base; readonly prompt: string }
  | { readonly type: "PostToolUse" | "PostToolUseFailure"; readonly base: Base; readonly tool: ToolUse }
  | { readonly type: "SubagentStart"; readonly base: Base; readonly agentType: string | null }
  /** The main chat starting a subagent (Agent tool): its title as Claude Code shows it, and the prompt it is given. */
  | { readonly type: "PreToolUse"; readonly base: Base; readonly title: string | null; readonly prompt: string }
  | { readonly type: "SubagentStop"; readonly base: Base }
  | { readonly type: "Stop"; readonly base: Base };

export interface Base {
  readonly sessionId: string;
  /** The user turn the event belongs to (Claude Code >= 2.1.196; subagent events carry the spawning turn's). */
  readonly promptId: string | null;
  /** Present when the event happened inside a subagent. */
  readonly agentId: string | null;
}

export interface ToolUse {
  readonly name: string;
  readonly filePath: string | null;
  /** Edit: old/new strings; MultiEdit: each edit; Write: new = content. */
  readonly edits: readonly { readonly oldText: string | null; readonly newText: string }[];
  /** The file's content before the tool ran, when the response carries it (Edit, Write updates). */
  readonly originalFile: string | null;
  readonly command: string | null;
  /** PostToolUseFailure only. */
  readonly error: string | null;
}

/** Tools that start a subagent (PreToolUse matcher; `Task` is the tool's older name). */
export const AGENT_TOOLS = ["Agent", "Task"] as const;

/** Tools whose PostToolUse / PostToolUseFailure events are delivered (the injected matcher). */
export const OBSERVED_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"] as const;
export const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toolUse(e: Json): ToolUse {
  const input = isObj(e["tool_input"]) ? e["tool_input"] : {};
  const response = isObj(e["tool_response"]) ? e["tool_response"] : {};
  const name = str(e["tool_name"]) ?? "";
  let edits: ToolUse["edits"] = [];
  if (name === "Edit") edits = [{ oldText: str(input["old_string"]), newText: str(input["new_string"]) ?? "" }];
  else if (name === "Write") edits = [{ oldText: null, newText: str(input["content"]) ?? "" }];
  else if (name === "MultiEdit" && Array.isArray(input["edits"])) edits = input["edits"].filter(isObj).map((x) => ({ oldText: str(x["old_string"]), newText: str(x["new_string"]) ?? "" }));
  return {
    name,
    filePath: str(input["file_path"]) ?? str(input["notebook_path"]),
    edits,
    originalFile: str(response["originalFile"]),
    command: str(input["command"]),
    error: str(e["error"]),
  };
}

export function parseHookEvent(body: Buffer): HookEvent | null {
  let e: unknown;
  try {
    e = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (!isObj(e)) return null;
  const sessionId = str(e["session_id"]);
  if (sessionId === null) return null;
  const base: Base = { sessionId, promptId: str(e["prompt_id"]), agentId: str(e["agent_id"]) || null };
  switch (e["hook_event_name"]) {
    case "UserPromptSubmit":
      return { type: "UserPromptSubmit", base, prompt: str(e["prompt"]) ?? "" };
    case "PostToolUse":
    case "PostToolUseFailure":
      return { type: e["hook_event_name"], base, tool: toolUse(e) };
    case "PreToolUse": {
      const input = isObj(e["tool_input"]) ? e["tool_input"] : {};
      const prompt = str(input["prompt"]);
      if (!(AGENT_TOOLS as readonly unknown[]).includes(e["tool_name"]) || prompt === null) return null;
      return { type: "PreToolUse", base, title: str(input["description"]) || null, prompt };
    }
    case "SubagentStart":
      return { type: "SubagentStart", base, agentType: str(e["agent_type"]) || null };
    case "SubagentStop":
      return { type: "SubagentStop", base };
    case "Stop":
      return { type: "Stop", base };
    default:
      return null;
  }
}
