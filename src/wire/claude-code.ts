// The ONLY module that reads Claude Code request bodies. parseRequest() turns raw bytes into a RequestView: who sent
// it (main chat / subagent), what kind of turn it is, and the text a decision would be based on. It never throws and
// never mutates or re-serialises the body. Evidence for every rule: docs/wire-format.md and the fixture manifest.
import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  BETA_EXTENDED_CACHE_TTL, BETA_MID_CONVERSATION_SYSTEM, BILLING_ENTRYPOINT, HEADER_AGENT_ID, HEADER_SESSION_ID, LOCAL_COMMAND_BLOCK,
  INJECTED_PROMPT_MARKERS, MARKER_AGENT_PROMPT, MARKER_BILLING, MARKER_SUBAGENT, PASTED_CONTENT_TAG, SIDE_MARKERS, SYSTEM_REMINDER, USER_AGENT_VERSION, type SideKind,
} from "./markers.js";

export type RequestKind = "main" | "subagent" | "unknown";
/** Which signal classified a subagent. Header first; the system-prompt markers are the fallback. */
export type KindSignal = "header" | "marker:cc_is_subagent" | "marker:agent_prompt" | "none";
/**
 * new          a positively identified start of work: a user-typed main-chat prompt, or a subagent's first request
 * continuation a tool-loop step (the last message carries only tool results)
 * side         everything else: harness side calls, notifications, anything not positively identified. Never decided.
 */
export type Turn = "new" | "continuation" | "side";

export interface Signals {
  /** x-claude-code-agent-id present. */
  readonly header: boolean;
  /** cc_is_subagent=true in the system prompt. */
  readonly s1: boolean;
  /** "You are an agent for Claude Code" in the system prompt (optional marker). */
  readonly s2: boolean;
  /** x-anthropic-billing-header: in the system prompt (Claude Code client). */
  readonly s3: boolean;
}

/** Raw structural facts, used by the shape assertions. No content. */
export interface ShapeFacts {
  readonly headerSessionId: string | null;
  readonly metadataSessionId: string | null;
  readonly systemMessages: number;
  readonly nonSystemMessages: number;
  readonly lastNonSystemRole: string | null;
  readonly betaMidConversationSystem: boolean;
  readonly betaExtendedCacheTtl: boolean;
}

export interface RequestView {
  readonly sessionId: string | null;
  readonly agentId: string | null;
  readonly kind: RequestKind;
  readonly signal: KindSignal;
  readonly signals: Signals;
  readonly turn: Turn;
  readonly sideKind: SideKind | null;
  readonly entrypoint: string | null;
  /** claude-cli/<version> from the user-agent, the version of the client that actually talks to us. */
  readonly clientVersion: string | null;
  readonly requestedModel: string | null;
  readonly requestedEffort: string | null;
  readonly toolCount: number;
  /** Stable per conversation: main chat = session + first message text; subagent = session + agent id. */
  readonly convKey: string | null;
  /** The user's (or, for a subagent, the delegating agent's) own text for a `new` turn; null otherwise. */
  readonly task: string | null;
  /** Text of the assistant message right before a main-chat `new` turn; null otherwise. */
  readonly previousAssistantText: string | null;
  readonly facts: ShapeFacts;
}

export type ParseResult = { readonly ok: true; readonly view: RequestView } | { readonly ok: false; readonly reason: "not_json" | "not_object" };

/** `POST /v1/messages` (any query string). Everything else, including count_tokens, is never classified. */
export function isMessagesRequest(method: string, url: string): boolean {
  return method === "POST" && url.split("?")[0] === "/v1/messages";
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const header = (h: IncomingHttpHeaders, name: string): string | null => {
  const v = h[name];
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? null) : null;
};

interface Block {
  readonly type: string;
  readonly text: string | null;
}
/** Content as blocks; a plain-string content becomes one text block. */
const blocksOf = (m: Json): Block[] => {
  const c = m["content"];
  if (typeof c === "string") return [{ type: "text", text: c }];
  if (!Array.isArray(c)) return [];
  return c.filter(isObj).map((b) => ({ type: str(b["type"]) ?? "unknown", text: str(b["text"]) }));
};
/** The harness sends each reminder as its own text block starting with the tag; inline ones are stripped too. */
const isReminderOnly = (t: string): boolean => t.trimStart().startsWith("<system-reminder>") || t.replace(SYSTEM_REMINDER, "").trim() === "";
/** The user's own words: reminder blocks dropped, inline reminders and local-command wrappers removed, pasted-content tags unwrapped. */
const ownText = (blocks: readonly Block[]): string =>
  blocks
    .filter((b) => b.type === "text" && b.text !== null && !isReminderOnly(b.text))
    .map((b) => (b.text ?? "").replace(SYSTEM_REMINDER, "").replace(LOCAL_COMMAND_BLOCK, "").replace(PASTED_CONTENT_TAG, "").trim())
    .filter(Boolean)
    .join("\n\n");

const systemText = (body: Json): string => {
  const s = body["system"];
  if (typeof s === "string") return s;
  if (Array.isArray(s)) return s.filter(isObj).map((b) => str(b["text"]) ?? "").join("\n");
  return "";
};

const metadataSessionId = (body: Json): string | null => {
  const md = body["metadata"];
  const raw = isObj(md) ? str(md["user_id"]) : null;
  if (raw === null) return null;
  try {
    const o: unknown = JSON.parse(raw);
    return isObj(o) ? str(o["session_id"]) : null;
  } catch {
    return null;
  }
};

const sha = (s: string): string => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

interface TurnResult {
  readonly turn: Turn;
  readonly sideKind: SideKind | null;
  readonly task: string | null;
}
const side = (k: SideKind): TurnResult => ({ turn: "side", sideKind: k, task: null });

/** Pure. Anything not positively identified as a user turn or a tool-loop step is `side`. */
function classifyTurn(nonSystem: readonly Json[], toolCount: number, kind: RequestKind): TurnResult {
  if (toolCount === 0) return side("no_tools");
  const last = nonSystem.at(-1);
  if (!last || last["role"] !== "user") return side("unclassified");
  const blocks = blocksOf(last);
  const texts = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "");
  for (const m of SIDE_MARKERS) if (texts.some((t) => t.includes(m.text))) return side(m.kind);

  if (blocks.some((b) => b.type === "tool_result")) {
    // A tool-loop step carries tool results and at most harness reminders; anything else is not positively identified.
    const onlyResults = blocks.every((b) => b.type === "tool_result" || (b.type === "text" && isReminderOnly(b.text ?? "")));
    return onlyResults ? { turn: "continuation", sideKind: null, task: null } : side("unclassified");
  }
  // Every observed user-typed prompt (both entrypoints) and every subagent start arrives as an array of blocks;
  // plain-string contents were all harness side calls.
  if (typeof last["content"] === "string") return side("unclassified");
  if (blocks.some((b) => b.type !== "text")) return side("unclassified"); // images etc.: not handled yet
  const task = ownText(blocks);
  if (task === "") return side("unclassified");
  // A subagent's work starts with its first request; a later text message inside its run is not a new task.
  if (kind === "subagent" && nonSystem.length !== 1) return side("unclassified");
  return { turn: "new", sideKind: null, task };
}

/** The assistant text right before the last message (thinking and tool_use blocks excluded). */
function previousAssistant(nonSystem: readonly Json[]): string | null {
  const prev = nonSystem.at(-2);
  if (!prev || prev["role"] !== "assistant") return null;
  const t = blocksOf(prev)
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n\n")
    .trim();
  return t === "" ? null : t;
}

/**
 * For a hook `UserPromptSubmit.prompt`: the side kind when Claude Code injected the message itself (another
 * session's message, a task notification, ...), null for a prompt the user typed. Prefix match, after whitespace and
 * a leading <system-reminder> tag, so a typed prompt that merely quotes a marker is not affected.
 */
export function injectedPromptKind(prompt: string): SideKind | null {
  const head = prompt.trimStart().replace(/^<system-reminder>\s*/, "");
  return INJECTED_PROMPT_MARKERS.find((m) => head.startsWith(m.text))?.kind ?? null;
}

export function parseRequest(headers: IncomingHttpHeaders, body: Buffer): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!isObj(parsed)) return { ok: false, reason: "not_object" };
  const b = parsed;

  const sys = systemText(b);
  const agentId = header(headers, HEADER_AGENT_ID);
  const signals: Signals = { header: agentId !== null, s1: sys.includes(MARKER_SUBAGENT), s2: sys.includes(MARKER_AGENT_PROMPT), s3: sys.includes(MARKER_BILLING) };
  const signal: KindSignal = signals.header ? "header" : signals.s1 ? "marker:cc_is_subagent" : signals.s2 ? "marker:agent_prompt" : "none";
  const kind: RequestKind = signal !== "none" ? "subagent" : signals.s3 ? "main" : "unknown";

  const messages = Array.isArray(b["messages"]) ? b["messages"].filter(isObj) : [];
  const nonSystem = messages.filter((m) => m["role"] !== "system");
  const toolCount = Array.isArray(b["tools"]) ? b["tools"].length : 0;
  const betas = (header(headers, "anthropic-beta") ?? "").split(",").map((x) => x.trim());

  const headerSessionId = header(headers, HEADER_SESSION_ID);
  const mdSessionId = metadataSessionId(b);
  const sessionId = headerSessionId ?? mdSessionId;

  const t = classifyTurn(nonSystem, toolCount, kind);

  let convKey: string | null = null;
  if (sessionId !== null && kind !== "unknown") {
    if (kind === "subagent" && agentId !== null) convKey = `${sha(sessionId)}:a:${sha(agentId)}`;
    else {
      const first = messages[0];
      const firstText = first ? blocksOf(first).map((x) => x.text ?? "").join("\n") : "";
      convKey = `${sha(sessionId)}:${kind === "main" ? "m" : "s"}:${sha(firstText)}`;
    }
  }

  const oc = b["output_config"];
  const ua = header(headers, "user-agent") ?? "";
  return {
    ok: true,
    view: {
      sessionId,
      agentId,
      kind,
      signal,
      signals,
      turn: t.turn,
      sideKind: t.sideKind,
      entrypoint: BILLING_ENTRYPOINT.exec(sys)?.[1] ?? null,
      clientVersion: USER_AGENT_VERSION.exec(ua)?.[1] ?? null,
      requestedModel: str(b["model"]),
      requestedEffort: isObj(oc) ? str(oc["effort"]) : null,
      toolCount,
      convKey,
      task: t.task,
      previousAssistantText: t.turn === "new" && kind === "main" ? previousAssistant(nonSystem) : null,
      facts: {
        headerSessionId,
        metadataSessionId: mdSessionId,
        systemMessages: messages.length - nonSystem.length,
        nonSystemMessages: nonSystem.length,
        lastNonSystemRole: str(nonSystem.at(-1)?.["role"]),
        betaMidConversationSystem: betas.some((x) => x.startsWith(BETA_MID_CONVERSATION_SYSTEM)),
        betaExtendedCacheTtl: betas.some((x) => x.startsWith(BETA_EXTENDED_CACHE_TTL)),
      },
    },
  };
}

