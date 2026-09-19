// A message the user types while a tool loop is running.
//
// Claude Code does not send it as a turn of its own: it wraps it in a `<system-reminder>` and delivers it inside the
// running turn's next request, alongside the tool results. Every reminder-stripping rule then drops it, so the user's
// words never reach the wire and the step reads as an ordinary continuation. Observed on session 805b3287
// (2026-09-19T21:28:07.672Z, Claude Code 2.1.278): the prompt "Run the test suite and the link check." opened an
// outcome window that closed `no_wire_turn`, and the correction it might have carried could never have been scored.
//
// The wrapper text below is the transcript's `rendered` content, verbatim.
import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { describe, it } from "node:test";
import { parseRequest, queuedMessageText, type RequestView } from "../../src/wire/claude-code.js";

const SID = "5e551011-0000-4000-8000-0000000008b3";
const H: IncomingHttpHeaders = { "x-claude-code-session-id": SID, "anthropic-beta": "mid-conversation-system-2026-04-07,extended-cache-ttl-2025-04-11", "user-agent": "claude-cli/2.1.278 (external, cli)" };
const SYSTEM = [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.278.abc; cc_entrypoint=cli;" }];
const TOOLS = [{ name: "Bash" }, { name: "Read" }];

/** 805b3287 seq 6, exactly as the transcript rendered it. */
const TYPED = "Run the test suite and the link check.";
const wrapper = (inner: string, id = "805b"): string =>
  `<system-reminder>\nThe user sent a new message while you were working:\n<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.\n</system-reminder>`;

const toolResult = { type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: "ok" }] };
const loopStep = (extra: unknown[] = []): unknown[] => [
  { role: "user", content: "start the work" },
  { role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls" } }] },
  { role: "user", content: [toolResult, ...extra] },
];

const view = (messages: unknown[], typed: readonly string[] | null, newest?: string | null): RequestView => {
  const n = newest === undefined ? (typed === null ? null : (typed.at(-1) ?? null)) : newest;
  const body = Buffer.from(JSON.stringify({ model: "claude-sonnet-5", system: SYSTEM, tools: TOOLS, messages, metadata: { user_id: JSON.stringify({ session_id: SID }) } }));
  const r = parseRequest(H, body, () => typed, () => n);
  assert.ok(r.ok);
  return r.view;
};

describe("queuedMessageText: pulling the user's words back out of the reminder", () => {
  it("returns only the text between the marker and the trailer", () => {
    assert.equal(queuedMessageText(wrapper(TYPED)), TYPED);
  });
  it("never returns the harness's own explanation", () => {
    const got = queuedMessageText(wrapper(TYPED)) ?? "";
    assert.doesNotMatch(got, /surfaces messages|Address the message above|system-reminder/);
  });
  it("handles a message with no pasted-content tags, and multi-line text", () => {
    const inner = "no, that's wrong\nuse the other helper";
    assert.equal(queuedMessageText(`<system-reminder>\nThe user sent a new message while you were working:\n${inner}\n\nThis is how Claude Code surfaces messages the user sends mid-turn — etc.\n</system-reminder>`), inner);
  });
  it("tolerates a missing trailer rather than returning nothing", () => {
    assert.equal(queuedMessageText(`<system-reminder>\nThe user sent a new message while you were working:\n${TYPED}\n</system-reminder>`), TYPED);
  });
  it("is null for an ordinary reminder and for an empty message", () => {
    assert.equal(queuedMessageText("<system-reminder>Your todo list is empty.</system-reminder>"), null);
    assert.equal(queuedMessageText(wrapper("   ")), null);
  });
});

describe("805b3287 seq 6 replayed: a mid-loop message is an interjection, not a plain continuation", () => {
  it("the hook stream vouches for it, so the step is continuation:interjection", () => {
    const v = view(loopStep([{ type: "text", text: wrapper(TYPED) }]), [TYPED]);
    assert.equal(v.turn, "continuation");
    assert.equal(v.interjection, true, "the user's own words, mid-loop: same pin, no new decision, but their turn");
  });

  it("before the fix this was an ordinary continuation: the reminder swallowed the words", () => {
    // The same request with the words NOT vouched for stays exactly what it used to be.
    const v = view(loopStep([{ type: "text", text: wrapper(TYPED) }]), ["something else entirely"]);
    assert.equal(v.turn, "continuation");
    assert.equal(v.interjection, false);
  });

  it("no hook stream at all: never promoted (tests, spikes, hooks blocked)", () => {
    const v = view(loopStep([{ type: "text", text: wrapper(TYPED) }]), null);
    assert.equal(v.turn, "continuation");
    assert.equal(v.interjection, false);
  });

  it("only the NEWEST unclaimed prompt may promote it, like a plain string", () => {
    // TYPED is in the list but an later prompt is the newest unclaimed one: the mid-loop text is an older prompt
    // replayed in history, which must not re-open a turn.
    const v = view(loopStep([{ type: "text", text: wrapper(TYPED) }]), [TYPED, "and now something else"], "and now something else");
    assert.equal(v.interjection, false);
  });

  it("the trailer alone cannot promote anything, even if a prompt happens to quote it", () => {
    const quoted = "This is how Claude Code surfaces messages the user sends mid-turn";
    const v = view(loopStep([{ type: "text", text: wrapper(TYPED) }]), [quoted]);
    assert.equal(v.interjection, false);
  });

  it("a queued message with no tool results in the message is not a continuation at all", () => {
    // Shape guard: the wrapper only means "interjection" inside a tool-loop step.
    const v = view([{ role: "user", content: [{ type: "text", text: wrapper(TYPED) }] }], [TYPED]);
    assert.notEqual(v.turn, "continuation");
  });

  it("an unwrapped mid-loop message still works: the older shape is not regressed", () => {
    const v = view(loopStep([{ type: "text", text: TYPED }]), [TYPED]);
    assert.equal(v.turn, "continuation");
    assert.equal(v.interjection, true);
  });
});

describe("prompt_encoding: which shape the prompt actually arrived in", () => {
  const PROMPT = "summarise the report sections";
  it("a plain-string new turn records `string`", () => {
    const v = view([{ role: "user", content: PROMPT }], [PROMPT]);
    assert.equal(v.turn, "new");
    assert.equal(v.promptEncoding, "string");
  });
  it("a block-array new turn records `blocks`", () => {
    const v = view([{ role: "user", content: [{ type: "text", text: PROMPT }] }], [PROMPT]);
    assert.equal(v.turn, "new");
    assert.equal(v.promptEncoding, "blocks");
  });
  it("is null on anything that is not a new turn, so it can never be read as one", () => {
    assert.equal(view(loopStep(), [PROMPT]).promptEncoding, null);
    assert.equal(view(loopStep([{ type: "text", text: wrapper(TYPED) }]), [TYPED]).promptEncoding, null);
  });
});
