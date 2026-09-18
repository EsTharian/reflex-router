// Every string reflex relies on to recognise Claude Code traffic, in one place. None of this is a public contract:
// each entry names the fixture (test/fixtures/claude-code/<version>/) where it was observed, and the contract tests
// fail when a fixture stops matching.

/** Request headers. */
export const HEADER_SESSION_ID = "x-claude-code-session-id"; // every request; == metadata.user_id.session_id == hook session_id
export const HEADER_AGENT_ID = "x-claude-code-agent-id"; // subagent requests only; == hook agent_id (sonnet-agent-run.subagent-*, interactive.subagent-*)
export const BETA_MID_CONVERSATION_SYSTEM = "mid-conversation-system-"; // prefix; allows role:"system" messages
export const BETA_EXTENDED_CACHE_TTL = "extended-cache-ttl-"; // prefix; 1-hour cache writes (main chat, not subagents, not compaction)

/** `user-agent: claude-cli/2.1.277 (external, cli)`. The HEAD /api/hello probe carries `Bun/…` instead. */
export const USER_AGENT_VERSION = /^claude-cli\/(\d+\.\d+\.\d+)/;

/** System-prompt markers. S1 is set by the harness for every subagent; S2 is the built-in general-purpose agent's
 * prompt and is OPTIONAL (absent on the interactive Explore subagent): never required, logged when seen. */
export const MARKER_BILLING = "x-anthropic-billing-header:"; // S3: the client is Claude Code
export const MARKER_SUBAGENT = "cc_is_subagent=true"; // S1
export const MARKER_AGENT_PROMPT = "You are an agent for Claude Code"; // S2 (optional)
export const BILLING_ENTRYPOINT = /cc_entrypoint=([^;\s]+)/;

/** Wrappers the harness puts around text that is not the user's own prompt. Stripped before judging a turn. */
export const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** Claude Code wraps pasted text as `<pasted_content id="…">…</pasted_content id="…">`; the tags go, the text stays. */
export const PASTED_CONTENT_TAG = /<\/?pasted_content(?:\s+id="[^"]*")?\s*>/g;
export const LOCAL_COMMAND_BLOCK = /<(local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;

export type SideKind = "no_tools" | "suggestion" | "agent_summary" | "compaction" | "cross_session" | "notification" | "unclassified";

/**
 * Harness-generated requests that carry the full tool list and look like turns. Matched ONLY against the last
 * non-system message (these texts stay in the history and reappear in later requests).
 */
export const SIDE_MARKERS: readonly { readonly kind: Exclude<SideKind, "no_tools" | "unclassified">; readonly text: string; readonly evidence: string }[] = [
  { kind: "suggestion", text: "[SUGGESTION MODE:", evidence: "interactive.main-suggestion" },
  { kind: "agent_summary", text: "Describe your most recent action", evidence: "interactive.subagent-summary" },
  { kind: "compaction", text: "CRITICAL: Respond with TEXT ONLY", evidence: "interactive.main-compaction" },
  { kind: "cross_session", text: "Another Claude session sent a message:", evidence: "interactive.main-cross-session" },
  { kind: "notification", text: "[SYSTEM NOTIFICATION - NOT USER INPUT]", evidence: "interactive.main-notification" },
];
