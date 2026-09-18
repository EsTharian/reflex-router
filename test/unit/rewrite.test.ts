import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retarget, HAIKU_THINKING_BUDGET } from "../../src/wire/rewrite.js";
import { loadFixtures } from "../support/fixtures.js";

type Json = Record<string, unknown>;
const HAIKU = "claude-haiku-4-5-20251001";
const fixtures = loadFixtures();
const fx = (name: string): Buffer => {
  const f = fixtures.find((x) => x.file === name);
  assert.ok(f, name);
  return f.body;
};
const toHaiku = (body: Buffer, drop = false): Json => {
  const r = retarget(body, { from: "sonnet", to: "haiku", model: HAIKU, dropHistoryThinking: drop });
  assert.ok(r.ok);
  return JSON.parse(r.body.toString()) as Json;
};
const roles = (b: Json): string => (b["messages"] as Json[]).map((m) => String(m["role"])[0]).join("");
const cacheMarks = (v: unknown): number => (JSON.stringify(v).match(/"cache_control"/g) ?? []).length;

describe("retarget Sonnet 5 -> Haiku 4.5", () => {
  it("matches the native Haiku request field by field on the fields the API requires", () => {
    const b = toHaiku(fx("sonnet-agent-run.main-new-turn.request.json"));
    assert.equal(b["model"], HAIKU);
    assert.equal(b["output_config"], undefined, "effort was its only key");
    assert.deepEqual(b["thinking"], { type: "enabled", budget_tokens: HAIKU_THINKING_BUDGET, display: "omitted" });
    assert.ok(!(b["messages"] as Json[]).some((m) => m["role"] === "system"));
    const native = JSON.parse(fx("haiku-mcp-draft4.main-new-turn.request.json").toString()) as Json;
    assert.deepEqual(b["context_management"], native["context_management"], "context_management is kept, as natively");
    assert.equal((native["thinking"] as Json)["type"], "enabled");
  });

  it("reports exactly the fields it rewrote", () => {
    const r = retarget(fx("sonnet-agent-run.main-continuation-tool-error.request.json"), { from: "sonnet", to: "haiku", model: HAIKU });
    assert.ok(r.ok);
    assert.deepEqual(r.fields, ["model", "output_config.effort", "thinking", "messages.system_folded:3"]);
  });

  it("folds mid-list and trailing system messages into the closest earlier user message, keeping tool_result first", () => {
    const before = JSON.parse(fx("sonnet-agent-run.main-continuation-tool-error.request.json").toString()) as Json;
    assert.equal(roles(before), "usausaus");
    const b = toHaiku(fx("sonnet-agent-run.main-continuation-tool-error.request.json"));
    assert.equal(roles(b), "uauau", "strict user/assistant alternation");
    const msgs = b["messages"] as Json[];
    const last = msgs.at(-1)!["content"] as Json[];
    assert.equal(last[0]!["type"], "tool_result", "tool_result blocks stay first");
    assert.equal(cacheMarks(b["messages"]), cacheMarks(before["messages"]), "cache_control markers are neither lost nor added");
  });

  it("handles the interactive shape: system at index 1, thinking without `display`", () => {
    const b = toHaiku(fx("interactive.main-continuation.request.json"));
    assert.deepEqual(b["thinking"], { type: "enabled", budget_tokens: HAIKU_THINKING_BUDGET });
    assert.equal(roles(b), "uau");
  });

  it("a system message before any user message goes to the start of the next user message", () => {
    const body = Buffer.from(JSON.stringify({ model: "claude-sonnet-5", max_tokens: 64000, messages: [{ role: "system", content: "S" }, { role: "user", content: [{ type: "text", text: "U" }] }] }));
    const b = toHaiku(body);
    assert.deepEqual(b["messages"], [{ role: "user", content: [{ type: "text", text: "S" }, { type: "text", text: "U" }] }]);
  });

  it("is deterministic over a growing tool loop: request k's rewritten history is a prefix of request k+1's", () => {
    const k = [{ role: "user", content: [{ type: "text", text: "go" }] }, { role: "system", content: "env" }];
    const k1 = [...k, { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t" }] }, { role: "system", content: "later" }];
    const mk = (messages: unknown[]): Buffer => Buffer.from(JSON.stringify({ model: "claude-sonnet-5", max_tokens: 64000, messages }));
    const a = toHaiku(mk(k))["messages"] as Json[];
    const c = toHaiku(mk(k1))["messages"] as Json[];
    assert.deepEqual(c[0], a[0]);
  });

  it("keeps other output_config keys (e.g. a JSON-schema format) and only removes effort", () => {
    const body = Buffer.from(JSON.stringify({ model: "claude-sonnet-5", max_tokens: 100, messages: [], output_config: { effort: "high", format: { type: "json_schema" } }, thinking: { type: "disabled" } }));
    const r = retarget(body, { from: "sonnet", to: "haiku", model: HAIKU });
    assert.ok(r.ok);
    const b = JSON.parse(r.body.toString()) as Json;
    assert.deepEqual(b["output_config"], { format: { type: "json_schema" } });
    assert.deepEqual(b["thinking"], { type: "disabled" });
    assert.deepEqual(r.fields, ["model", "output_config.effort"]);
  });

  it("caps the thinking budget below max_tokens, and refuses when no valid budget fits", () => {
    const mk = (max: number): Buffer => Buffer.from(JSON.stringify({ model: "claude-sonnet-5", max_tokens: max, messages: [], thinking: { type: "adaptive" } }));
    const r = retarget(mk(8000), { from: "sonnet", to: "haiku", model: HAIKU });
    assert.ok(r.ok);
    assert.deepEqual((JSON.parse(r.body.toString()) as Json)["thinking"], { type: "enabled", budget_tokens: 7999 });
    assert.deepEqual(retarget(mk(1000), { from: "sonnet", to: "haiku", model: HAIKU }), { ok: false, reason: "thinking_budget_too_small" });
  });

  it("optionally drops another model's thinking blocks from the history, and says how many", () => {
    const r = retarget(fx("interactive.main-continuation.request.json"), { from: "sonnet", to: "haiku", model: HAIKU, dropHistoryThinking: true });
    assert.ok(r.ok);
    assert.ok(r.fields.includes("messages.thinking_dropped:1"));
    assert.doesNotMatch(r.body.toString(), /"type":"thinking"/);
  });

  it("refuses non-JSON and bodies without messages", () => {
    assert.deepEqual(retarget(Buffer.from("x"), { from: "sonnet", to: "haiku", model: HAIKU }), { ok: false, reason: "not_json" });
    assert.deepEqual(retarget(Buffer.from("{}"), { from: "sonnet", to: "haiku", model: HAIKU }), { ok: false, reason: "no_messages" });
  });
});

describe("retarget within the adaptive families", () => {
  it("Opus -> Sonnet swaps only the model", () => {
    const r = retarget(fx("interactive.main-continuation.request.json"), { from: "opus", to: "sonnet", model: "claude-sonnet-5" });
    assert.ok(r.ok);
    assert.deepEqual(r.fields, ["model"]);
  });
});
