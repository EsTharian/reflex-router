// REFLEX_DELEGATE end to end: a UserPromptSubmit POSTed to the real front door comes back with the hint as
// additionalContext; everything else stays a 204; decision records carry the hint version; with the worker down the
// door still answers 204 (a broken injection never blocks a prompt).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { HINT_TEXT, HINT_VERSION } from "../../src/delegate/hint.js";
import { startFakeJev, type FakeJev } from "../support/fake-jev.js";
import { loadFixtures } from "../support/fixtures.js";
import { request, waitFor } from "../support/http.js";
import { allRecords, replay, sseHandler } from "../support/replay.js";
import { startStack, type Stack } from "../support/stack.js";

const fixture = loadFixtures().find((f) => f.file === "interactive.main-new-turn.request.json")!;
const SESSION = String(fixture.headers["x-claude-code-session-id"]);
const post = (stack: Stack, event: Record<string, unknown>) =>
  request(`${stack.url}/__reflex/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: SESSION, ...event }) });

describe("delegation hint through the front door (REFLEX_DELEGATE=1)", () => {
  let jev: FakeJev;
  let stack: Stack;
  before(async () => {
    jev = await startFakeJev({ kind: "answer", tier: "sonnet", confidence: 0.9, reasoning: 2 });
    stack = await startStack({ config: { jevBaseUrl: jev.url, delegate: true } });
    stack.upstream.setHandler(sseHandler);
  });
  after(async () => {
    await stack.close();
    await jev.close();
  });

  it("a typed prompt is answered with the hint; injected, slash and subagent prompts and other events get 204", async () => {
    const r = await post(stack, { hook_event_name: "UserPromptSubmit", prompt_id: "P1", prompt: "fix the parser" });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body.toString()), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: HINT_TEXT } });
    for (const prompt of ["<task-notification>\n<task-id>A</task-id>", '<agent-message from="AGENT-1">\nreport', "/compact"]) {
      assert.equal((await post(stack, { hook_event_name: "UserPromptSubmit", prompt_id: "P2", prompt })).status, 204, prompt);
    }
    assert.equal((await post(stack, { hook_event_name: "UserPromptSubmit", prompt_id: "P3", agent_id: "A1", prompt: "look around" })).status, 204);
    assert.equal((await post(stack, { hook_event_name: "Stop", prompt_id: "P1" })).status, 204);
    assert.equal((await request(`${stack.url}/__reflex/hook`, { method: "POST", body: "not json" })).status, 204);
  });

  it("decision records carry the hint version; each delivered hint is recorded without prompt text", async () => {
    const { rec } = await replay(stack, fixture);
    assert.equal(rec["delegate_hint"], HINT_VERSION);
    const hints = await waitFor(() => {
      const h = allRecords(stack).filter((x) => x["record"] === "delegate_hint");
      return h.length >= 1 ? h : null;
    });
    assert.equal(hints.length, 1, "only the one typed prompt got a hint");
    assert.equal(hints[0]!["version"], HINT_VERSION);
    assert.match(String(hints[0]!["session"]), /^[0-9a-f]{16}$/);
    assert.doesNotMatch(JSON.stringify(allRecords(stack)), /fix the parser/);
  });
});

describe("delegation hint: off and fail-open", () => {
  it("without REFLEX_DELEGATE a typed prompt gets 204 and records say null", async () => {
    const stack = await startStack();
    try {
      stack.upstream.setHandler(sseHandler);
      assert.equal((await post(stack, { hook_event_name: "UserPromptSubmit", prompt_id: "P1", prompt: "fix the parser" })).status, 204);
      const { rec } = await replay(stack, fixture);
      assert.equal(rec["delegate_hint"], null);
    } finally {
      await stack.close();
    }
  });
  it("with the worker down the front door answers 204: the prompt goes on without the hint", async () => {
    const stack = await startStack({ noWorker: true, config: { delegate: true } });
    try {
      assert.equal((await post(stack, { hook_event_name: "UserPromptSubmit", prompt_id: "P1", prompt: "fix the parser" })).status, 204);
    } finally {
      await stack.close();
    }
  });
});
