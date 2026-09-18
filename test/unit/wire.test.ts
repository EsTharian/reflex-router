// Wire edge cases on synthetic bodies, and shape assertions on mutated fixtures (each mutation trips one check).
import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { describe, it } from "node:test";
import { isMessagesRequest, parseRequest, type RequestView } from "../../src/wire/claude-code.js";
import { assertShape, ShapeTracker } from "../../src/wire/shape.js";
import { loadFixtures, viewOf, type Fixture } from "../support/fixtures.js";

const SID = "5e551011-0000-4000-8000-000000000001";
const H: IncomingHttpHeaders = { "x-claude-code-session-id": SID, "anthropic-beta": "mid-conversation-system-2026-04-07,extended-cache-ttl-2025-04-11", "user-agent": "claude-cli/2.1.277 (external, cli)" };
const SYSTEM = [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.277.abc; cc_entrypoint=cli;" }, { type: "text", text: "You are Claude Code." }];
const TOOLS = [{ name: "Bash" }, { name: "Read" }];
const reminder = (t: string): { type: string; text: string } => ({ type: "text", text: `<system-reminder>\n${t}\n</system-reminder>` });
const text = (t: string): { type: string; text: string } => ({ type: "text", text: t });

const view = (messages: unknown[], over: Record<string, unknown> = {}, headers: IncomingHttpHeaders = H): RequestView => {
  const r = parseRequest(headers, Buffer.from(JSON.stringify({ model: "claude-sonnet-5", system: SYSTEM, tools: TOOLS, messages, metadata: { user_id: JSON.stringify({ session_id: SID }) }, ...over })));
  assert.ok(r.ok);
  return r.view;
};

describe("parseRequest: robustness", () => {
  it("never throws on junk and reports why", () => {
    assert.deepEqual(parseRequest({}, Buffer.from("not json")), { ok: false, reason: "not_json" });
    assert.deepEqual(parseRequest({}, Buffer.from("[1,2]")), { ok: false, reason: "not_object" });
    const r = parseRequest({}, Buffer.from(JSON.stringify({ messages: "x", system: 5, tools: {}, metadata: { user_id: "{bad" } })));
    assert.ok(r.ok);
    assert.equal(r.view.kind, "unknown");
    assert.equal(r.view.turn, "side");
    assert.equal(r.view.sessionId, null);
  });

  it("only POST /v1/messages (any query) is classified; count_tokens is not", () => {
    assert.equal(isMessagesRequest("POST", "/v1/messages?beta=true"), true);
    assert.equal(isMessagesRequest("POST", "/v1/messages/count_tokens?beta=true"), false);
    assert.equal(isMessagesRequest("GET", "/v1/messages"), false);
    assert.equal(isMessagesRequest("HEAD", "/api/hello"), false);
  });
});

describe("turn classification: only positively identified user turns are `new`", () => {
  it("user text after reminders is new; the task excludes the reminders", () => {
    const v = view([{ role: "user", content: [reminder("ctx"), text("fix the bug")] }]);
    assert.equal(v.turn, "new");
    assert.equal(v.task, "fix the bug");
  });

  it("role:system messages anywhere are skipped", () => {
    const v = view([{ role: "user", content: [text("hi")] }, { role: "system", content: "env" }, { role: "assistant", content: [text("hello")] }, { role: "user", content: [text("next")] }, { role: "system", content: "x" }]);
    assert.equal(v.turn, "new");
    assert.equal(v.previousAssistantText, "hello");
    assert.equal(v.facts.systemMessages, 2);
  });

  it("parallel tool results (one message) are a continuation; results + reminders too", () => {
    assert.equal(view([{ role: "user", content: [{ type: "tool_result", tool_use_id: "a" }, { type: "tool_result", tool_use_id: "b" }] }]).turn, "continuation");
    assert.equal(view([{ role: "user", content: [{ type: "tool_result", tool_use_id: "a" }, reminder("note")] }]).turn, "continuation");
  });

  it("tool results with unexplained text are NOT positively identified", () => {
    const v = view([{ role: "user", content: [{ type: "tool_result", tool_use_id: "a" }, text("also do X")] }]);
    assert.deepEqual([v.turn, v.sideKind], ["side", "unclassified"]);
  });

  it("reminder-only, plain-string content, images, and a trailing assistant message are side/unclassified", () => {
    for (const msgs of [
      [{ role: "user", content: [reminder("only a reminder")] }],
      [{ role: "user", content: "plain string" }],
      [{ role: "user", content: [text("look"), { type: "image", source: {} }] }],
      [{ role: "user", content: [text("hi")] }, { role: "assistant", content: [text("prefill")] }],
      [],
    ]) {
      const v = view(msgs);
      assert.deepEqual([v.turn, v.sideKind, v.task], ["side", "unclassified", null], JSON.stringify(msgs));
    }
  });

  it("no tools (or an empty tools list) is side/no_tools", () => {
    assert.equal(view([{ role: "user", content: [text("hi")] }], { tools: [] }).sideKind, "no_tools");
    assert.equal(view([{ role: "user", content: [text("hi")] }], { tools: undefined }).sideKind, "no_tools");
  });

  it("each harness side-call marker in the LAST message wins over everything", () => {
    const cases: [unknown, string][] = [
      ["[SUGGESTION MODE: Suggest what the user might type]", "suggestion"],
      [[text("Describe your most recent action in 3-5 words")], "agent_summary"],
      [[{ type: "tool_result", tool_use_id: "a" }, text("CRITICAL: Respond with TEXT ONLY. Summarise.")], "compaction"],
      [[text("Another Claude session sent a message: hi")], "cross_session"],
      [[reminder("[SYSTEM NOTIFICATION - NOT USER INPUT] task done")], "notification"],
    ];
    for (const [content, kind] of cases) assert.equal(view([{ role: "user", content }]).sideKind, kind);
  });

  it("local-command wrappers are not the user's text", () => {
    const v = view([{ role: "user", content: [text("<local-command-caveat>Caveat</local-command-caveat>"), text("<command-name>/compact</command-name>"), text("did you update it?")] }]);
    assert.equal(v.task, "did you update it?");
    const only = view([{ role: "user", content: [text("<command-name>/model</command-name>")] }]);
    assert.equal(only.turn, "side");
  });

  it("a subagent's first request is new; a later text message inside its run is not", () => {
    const sh = { ...H, "x-claude-code-agent-id": "a0123456789abcdef" };
    const sys = [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.277.e1f; cc_entrypoint=cli; cc_is_subagent=true;" }];
    const first = view([{ role: "user", content: [text("list files")] }], { system: sys }, sh);
    assert.deepEqual([first.kind, first.signal, first.turn], ["subagent", "header", "new"]);
    assert.equal(first.previousAssistantText, null);
    const later = view([{ role: "user", content: [text("list files")] }, { role: "assistant", content: [text("ok")] }, { role: "user", content: [text("more")] }], { system: sys }, sh);
    assert.deepEqual([later.turn, later.sideKind], ["side", "unclassified"]);
    assert.equal(later.convKey, first.convKey, "keyed on the agent id");
  });

  it("markers are the fallback when the header is absent, and name the signal", () => {
    const s1 = view([{ role: "user", content: [text("t")] }], { system: [{ type: "text", text: "x-anthropic-billing-header: cc_is_subagent=true;" }] });
    assert.deepEqual([s1.kind, s1.signal], ["subagent", "marker:cc_is_subagent"]);
    const s2 = view([{ role: "user", content: [text("t")] }], { system: [{ type: "text", text: "x-anthropic-billing-header: x; You are an agent for Claude Code" }] });
    assert.deepEqual([s2.kind, s2.signal], ["subagent", "marker:agent_prompt"]);
    const none = view([{ role: "user", content: [text("t")] }], { system: [{ type: "text", text: "hello" }] });
    assert.deepEqual([none.kind, none.signal, none.convKey], ["unknown", "none", null]);
  });

  it("session id: header first, metadata fallback; ids never appear in the conversation key", () => {
    const noHeader = view([{ role: "user", content: [text("t")] }], {}, { "anthropic-beta": "" });
    assert.equal(noHeader.sessionId, SID);
    assert.ok(noHeader.convKey && !noHeader.convKey.includes(SID));
  });
});

describe("shape assertions on mutated fixtures: each mutation trips exactly its check", () => {
  const fixtures = loadFixtures();
  const base = fixtures.find((f) => f.file === "interactive.main-new-turn.request.json");
  const subBase = fixtures.find((f) => f.file === "interactive.subagent-continuation.request.json");
  assert.ok(base && subBase);
  const mutate = (fx: Fixture, fn: (body: Record<string, unknown>, headers: Record<string, unknown>) => void): RequestView => {
    const body = JSON.parse(fx.body.toString()) as Record<string, unknown>;
    const headers = { ...fx.headers } as Record<string, unknown>;
    fn(body, headers);
    return viewOf({ ...fx, headers: headers as IncomingHttpHeaders, body: Buffer.from(JSON.stringify(body)) });
  };
  const checks = (v: RequestView): string[] => assertShape(v).map((x) => x.check);

  it("the unmutated fixtures pass", () => {
    assert.deepEqual(checks(viewOf(base)), []);
    assert.deepEqual(checks(viewOf(subBase)), []);
  });
  it("session_id: header and metadata disagree", () => {
    assert.deepEqual(checks(mutate(base, (_b, h) => (h["x-claude-code-session-id"] = "other-session"))), ["session_id"]);
  });
  it("session_id: neither source present", () => {
    assert.deepEqual(checks(mutate(base, (b, h) => { delete h["x-claude-code-session-id"]; delete b["metadata"]; })), ["session_id"]);
  });
  it("client_identity: billing marker gone", () => {
    assert.deepEqual(checks(mutate(base, (b) => (b["system"] = JSON.parse(JSON.stringify(b["system"]).replaceAll("x-anthropic-billing-header:", "x-other:")) as unknown))), ["client_identity"]);
  });
  it("subagent_signals: agent-id header without cc_is_subagent", () => {
    assert.deepEqual(checks(mutate(base, (_b, h) => (h["x-claude-code-agent-id"] = "a0000000000000000"))), ["subagent_signals"]);
  });
  it("subagent_signals: cc_is_subagent without the header", () => {
    assert.deepEqual(checks(mutate(subBase, (_b, h) => delete h["x-claude-code-agent-id"])), ["subagent_signals"]);
  });
  it("system_messages_beta: role:system messages without the beta", () => {
    assert.deepEqual(checks(mutate(base, (_b, h) => (h["anthropic-beta"] = String(h["anthropic-beta"]).replace(/mid-conversation-system-[^,]*/, "")))), ["system_messages_beta"]);
  });
  it("the optional agent-prompt marker on a main request trips subagent_signals only via its fallback classification", () => {
    const v = mutate(base, (b) => ((b["system"] as { text: string }[])[1]!.text += " You are an agent for Claude Code"));
    assert.equal(v.kind, "subagent");
    assert.deepEqual(checks(v), ["subagent_signals"]);
  });

  it("ShapeTracker: first violation degrades for good; N clean requests verify and stop checking", () => {
    const t = new ShapeTracker(2);
    const bad = mutate(base, (_b, h) => (h["x-claude-code-session-id"] = "other"));
    assert.deepEqual(t.observe(viewOf(base)), []);
    assert.equal(t.status, "checking");
    assert.equal(t.observe(bad).length, 1);
    assert.equal(t.status, "degraded");
    assert.equal(t.reason, "shape:session_id");
    assert.deepEqual(t.observe(viewOf(base)), []);
    assert.equal(t.status, "degraded");

    const ok = new ShapeTracker(2);
    ok.observe(viewOf(base));
    ok.observe(viewOf(base));
    assert.equal(ok.status, "verified");
    assert.deepEqual(ok.observe(bad), [], "no checks after verification");
  });

  it("side calls are never checked (compaction legitimately lacks the cache-TTL beta)", () => {
    const t = new ShapeTracker(10);
    const side = fixtures.find((f) => f.file === "interactive.main-compaction.request.json");
    assert.ok(side);
    const v = mutate(side, (_b, h) => (h["x-claude-code-session-id"] = "other"));
    assert.deepEqual(t.observe(v), []);
    assert.equal(t.status, "checking");
  });
});
