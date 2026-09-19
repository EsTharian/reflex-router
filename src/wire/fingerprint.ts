// Structural fingerprint of a side call the classifier could not name (`side` / `unclassified`), so it can be sent back
// and given a side_kind. Shape only, never the body: counts, roles, block types, a few request parameters and the beta
// list. The one piece of text is the first FINGERPRINT_HEAD_MAX code points of the last message, kept only when it looks
// like harness-generated text and matches none of the user-text heuristics below; only its preamble (first line, up to
// the first colon) is kept, because harness templates put what they fill in (paths, quoted messages) after it; it is
// redacted before it is kept.
// Pure, never throws on odd input (the router still guards the call).
import type { IncomingHttpHeaders } from "node:http";
import { head } from "../privacy/budget.js";
import { redact } from "../privacy/redact.js";
import { LOCAL_COMMAND_BLOCK, PASTED_CONTENT_TAG, SYSTEM_REMINDER } from "./markers.js";

/** Code points of harness text kept at most. A constant, deliberately not configurable. */
export const FINGERPRINT_HEAD_MAX = 80;
/** Bump when a field or a heuristic changes, so fingerprints from different builds are not merged by mistake. */
export const FINGERPRINT_VERSION = 1;
/** A long role sequence keeps its first ROLES_HEAD and last ROLES_TAIL letters. */
const ROLES_HEAD = 8;
const ROLES_TAIL = 30;
const MAX_BLOCK_TYPES = 12;

/**
 * Why `head` is null. Structural reasons first, then the user-text heuristics (any match drops the text):
 * - no_prompt_hooks   no UserPromptSubmit has been seen in this session, so typed prompts cannot be ruled out
 * - typed_prompt      the text overlaps a prompt the user typed in this session (hook payloads, held in memory only)
 * - user_wrapper      pasted-content or local-command wrappers: text the user pasted or a command they ran
 * - attachment        the message carries an image or document: user input
 * - not_template_start does not start like harness text (`<tag`, `[`, or an ASCII capital letter)
 * - non_ascii         letters outside ASCII (harness text is English ASCII; the user may write in any language)
 * - first_person      I / my / me / we / our: someone speaking for themselves
 * - path_or_url       a path, URL, e-mail address or home directory
 */
export type HeadOmitted =
  | "not_user_message" | "no_text" | "no_prompt_hooks" | "typed_prompt" | "user_wrapper" | "attachment"
  | "not_template_start" | "non_ascii" | "first_person" | "path_or_url";

export interface SideFingerprint {
  readonly v: typeof FINGERPRINT_VERSION;
  /** All messages, role:"system" ones included. */
  readonly messages: number;
  /** One letter per message in order: u(ser), a(ssistant), s(ystem), ?; long sequences are cut in the middle (`..`). */
  readonly roles: string;
  readonly tools: number;
  /** Some message carries a tool_result block. */
  readonly tool_result: boolean;
  readonly system: { readonly prompt: "absent" | "string" | "blocks"; readonly prompt_blocks: number; readonly messages: number };
  readonly last: { readonly role: string | null; readonly content: "string" | "blocks" | "other"; readonly blocks: readonly string[]; readonly text_chars: number };
  readonly max_tokens: number | null;
  readonly thinking: string | null;
  readonly effort: string | null;
  readonly stream: boolean | null;
  /** anthropic-beta header entries, sorted. */
  readonly betas: readonly string[];
  readonly head: string | null;
  readonly head_omitted: HeadOmitted | null;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const norm = (t: string): string => t.replace(/\s+/g, " ").trim().toLowerCase();

const roleLetter = (r: unknown): string => (r === "user" ? "u" : r === "assistant" ? "a" : r === "system" ? "s" : "?");
const blockTypes = (m: Json): string[] => (Array.isArray(m["content"]) ? m["content"].filter(isObj).map((b) => str(b["type"]) ?? "?") : []);

const REMINDER_OPEN = "<system-reminder>";
/** The first text of the message outside harness reminders (inline ones removed); else the content of its first reminder block. */
function firstText(m: Json): string | null {
  const c = m["content"];
  const texts = typeof c === "string" ? [c] : Array.isArray(c) ? c.filter(isObj).filter((b) => b["type"] === "text").map((b) => str(b["text"]) ?? "") : [];
  const isReminder = (t: string): boolean => t.trimStart().startsWith(REMINDER_OPEN);
  for (const t of texts) {
    const own = isReminder(t) ? "" : t.replace(SYSTEM_REMINDER, "").trim();
    if (own !== "") return own;
  }
  for (const t of texts.filter(isReminder)) {
    const inner = t.trimStart().slice(REMINDER_OPEN.length).replace(/<\/system-reminder>\s*$/, "").trim();
    if (inner !== "") return inner;
  }
  return null;
}

/** The template's fixed opening: the first line, cut after its first colon. */
const preamble = (t: string): string => {
  const line = t.trimStart().split("\n", 1)[0]!;
  const colon = line.indexOf(":");
  return (colon === -1 ? line : line.slice(0, colon + 1)).trim();
};

const FIRST_PERSON = /\b(i|i'm|i've|i'd|i'll|me|my|mine|we|we're|our|us)\b/i;
const PATH_OR_URL = /[a-z][a-z0-9+.-]*:\/\/|www\.|\S@\S|~[/\\]|(?:^|[\s"'`(])\.{0,2}\/[\w.-]|[A-Za-z]:\\|\\[\w.-]+\\|\b[\w-]+\.(?:ts|js|mjs|cjs|tsx|jsx|py|go|rs|java|rb|php|c|h|cpp|cs|md|json|ya?ml|toml|sh|sql|html|css|txt|lock)\b/i;

/** The first user-text heuristic the text matches, or null when it may be kept. `typed` null: no prompt hooks seen. */
function userTextReason(text: string, typed: readonly string[] | null): HeadOmitted | null {
  if (text.search(PASTED_CONTENT_TAG) !== -1 || text.search(LOCAL_COMMAND_BLOCK) !== -1) return "user_wrapper";
  if (typed === null) return "no_prompt_hooks";
  const t = norm(text);
  const lead = norm(head(text, FINGERPRINT_HEAD_MAX));
  if (typed.some((p) => {
    const q = norm(p);
    // The text is (the start of) a typed prompt, or contains the start of one (a harness prefix around the user's words).
    return q !== "" && (q.includes(lead) || (q.length >= 4 && t.includes(q.slice(0, 40))));
  })) return "typed_prompt";
  const lead80 = head(text.trimStart(), FINGERPRINT_HEAD_MAX);
  if (!/^(<[A-Za-z]|\[|[A-Z])/.test(lead80)) return "not_template_start";
  if (/[^\t\n\r\x20-\x7E]/.test(lead80)) return "non_ascii"; // anything but printable ASCII and whitespace
  if (FIRST_PERSON.test(lead80)) return "first_person";
  if (PATH_OR_URL.test(lead80)) return "path_or_url";
  return null;
}

/**
 * `typedPrompts`: the prompts UserPromptSubmit delivered in this session so far (in memory only), or null when none has
 * arrived. The fingerprint never contains any of them.
 */
export function sideFingerprint(headers: IncomingHttpHeaders, body: Buffer, typedPrompts: readonly string[] | null): SideFingerprint | null {
  let b: unknown;
  try {
    b = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (!isObj(b)) return null;
  const messages = Array.isArray(b["messages"]) ? b["messages"].filter(isObj) : [];
  const letters = messages.map((m) => roleLetter(m["role"])).join("");
  const roles = letters.length <= ROLES_HEAD + ROLES_TAIL ? letters : `${letters.slice(0, ROLES_HEAD)}..${letters.slice(-ROLES_TAIL)}`;
  const sys = b["system"];
  const nonSystem = messages.filter((m) => m["role"] !== "system");
  const last = nonSystem.at(-1);
  const lastBlocks = last ? blockTypes(last) : [];
  const lastContent = last === undefined ? "other" : typeof last["content"] === "string" ? "string" : Array.isArray(last["content"]) ? "blocks" : "other";
  const lastTextChars = last === undefined ? 0 : typeof last["content"] === "string" ? Array.from(last["content"]).length
    : Array.isArray(last["content"]) ? last["content"].filter(isObj).reduce((n, x) => n + Array.from(str(x["text"]) ?? "").length, 0) : 0;

  let headText: string | null = null;
  let omitted: HeadOmitted | null = null;
  if (!last || last["role"] !== "user") omitted = "not_user_message";
  else if (lastBlocks.some((t) => t === "image" || t === "document")) omitted = "attachment";
  else {
    const text = firstText(last);
    if (text === null) omitted = "no_text";
    else {
      omitted = userTextReason(text, typedPrompts);
      if (omitted === null) headText = head(redact(preamble(text)).replace(/\s+/g, " ").trim(), FINGERPRINT_HEAD_MAX) || null;
      if (headText === null && omitted === null) omitted = "no_text";
    }
  }

  const thinking = b["thinking"];
  const oc = b["output_config"];
  const beta = headers["anthropic-beta"];
  const betaText = Array.isArray(beta) ? beta.join(",") : typeof beta === "string" ? beta : "";
  return {
    v: FINGERPRINT_VERSION,
    messages: messages.length,
    roles,
    tools: Array.isArray(b["tools"]) ? b["tools"].length : 0,
    tool_result: messages.some((m) => blockTypes(m).includes("tool_result")),
    system: {
      prompt: typeof sys === "string" ? "string" : Array.isArray(sys) ? "blocks" : "absent",
      prompt_blocks: Array.isArray(sys) ? sys.length : 0,
      messages: messages.length - nonSystem.length,
    },
    last: { role: last ? str(last["role"]) : null, content: lastContent, blocks: lastBlocks.slice(0, MAX_BLOCK_TYPES), text_chars: lastTextChars },
    max_tokens: num(b["max_tokens"]),
    thinking: isObj(thinking) ? str(thinking["type"]) : null,
    effort: isObj(oc) ? str(oc["effort"]) : null,
    stream: typeof b["stream"] === "boolean" ? b["stream"] : null,
    betas: betaText.split(",").map((x) => x.trim()).filter(Boolean).sort(),
    head: headText,
    head_omitted: omitted,
  };
}
