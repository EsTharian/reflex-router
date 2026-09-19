// Outcome capture end to end: hook events POSTed to the real front door reach the worker's tracker, and the outcome
// records it writes into decisions.jsonl are joined to the decision record of the same turn.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startFakeJev, type FakeJev } from "../support/fake-jev.js";
import { loadFixtures } from "../support/fixtures.js";
import { request, waitFor } from "../support/http.js";
import { allRecords, replay, sseHandler } from "../support/replay.js";
import { startStack, type Stack } from "../support/stack.js";

const fixture = loadFixtures().find((f) => f.file === "interactive.main-new-turn.request.json")!;
const SESSION = String(fixture.headers["x-claude-code-session-id"]);

describe("outcome capture through the front door", () => {
  let jev: FakeJev;
  let stack: Stack;
  const hook = async (event: Record<string, unknown>): Promise<number> =>
    (await request(`${stack.url}/__reflex/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: SESSION, ...event }) })).status;

  before(async () => {
    jev = await startFakeJev({ kind: "answer", tier: "sonnet", confidence: 0.9, reasoning: 2 });
    stack = await startStack({ config: { jevBaseUrl: jev.url } });
    stack.upstream.setHandler(sseHandler);
  });
  after(async () => {
    await stack.close();
    await jev.close();
  });

  it("prompt -> wire turn -> edit -> failing test -> correction: one outcome record keyed to that turn's decision", async () => {
    assert.equal(await hook({ hook_event_name: "UserPromptSubmit", prompt_id: "P1", prompt: "fix the parser" }), 204);
    const { rec } = await replay(stack, fixture);
    assert.equal(await hook({ hook_event_name: "PostToolUse", prompt_id: "P1", tool_name: "Edit", tool_input: { file_path: "/r/p.ts", old_string: "a", new_string: "b" }, tool_response: {} }), 204);
    assert.equal(await hook({ hook_event_name: "PostToolUseFailure", prompt_id: "P1", tool_name: "Bash", tool_input: { command: "npm test" }, error: "Exit code 1" }), 204);
    assert.equal(await hook({ hook_event_name: "UserPromptSubmit", prompt_id: "P2", prompt: "no, that's wrong" }), 204);

    const outcome = await waitFor(() => allRecords(stack).find((r) => r["record"] === "outcome"), { what: "outcome record" });
    assert.equal(outcome["decision_id"], rec["id"], "joined to the decision of the same turn");
    const signals = outcome["signals"] as { test_failure_after_edit: { detected: boolean }; correction: { score: number } };
    assert.equal(signals.test_failure_after_edit.detected, true);
    assert.ok(signals.correction.score >= 1);
    assert.doesNotMatch(JSON.stringify(allRecords(stack)), /fix the parser|that's wrong|\/r\/p\.ts/, "no prompt text or paths in the log");
  });

  it("malformed or unknown hook bodies are still answered 204 and ignored", async () => {
    assert.equal(await hook({ hook_event_name: "SomethingNew" }), 204);
    assert.equal((await request(`${stack.url}/__reflex/hook`, { method: "POST", body: "not json" })).status, 204);
  });
});
