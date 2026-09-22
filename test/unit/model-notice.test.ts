// The chat notice for a main-chat model change: when it is queued, collapsed, and never for side calls or subagents.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelNotices } from "../../src/worker/model-notice.js";
import type { DecisionInfo } from "../../src/outcome/tracker.js";

const OPUS = "claude-opus-4-7";
const HAIKU = "claude-haiku-4-5";
const SONNET = "claude-sonnet-4-6";
const d = (sentModel: string, over: Partial<DecisionInfo> = {}): DecisionInfo => ({ id: "x", at: 0, sessionId: "s", agentId: null, kind: "main", turn: "new", conv: "c", requestedModel: OPUS, sentModel, ...over });

describe("model notices", () => {
  it("a downgrade, then the way back up, each once", () => {
    const n = new ModelNotices();
    n.observe(d(OPUS));
    assert.equal(n.take("s"), null, "on the requested model: nothing to say");
    n.observe(d(HAIKU));
    assert.equal(n.take("s"), `reflex downgraded the model: ${OPUS} → ${HAIKU}`);
    assert.equal(n.take("s"), null, "delivered once");
    n.observe(d(HAIKU, { turn: "continuation" }));
    assert.equal(n.take("s"), null, "same model: nothing");
    n.observe(d(OPUS));
    assert.equal(n.take("s"), `reflex upgraded the model: ${HAIKU} → ${OPUS}`);
  });
  it("changes before the next hook collapse; a round trip says nothing", () => {
    const n = new ModelNotices();
    n.observe(d(HAIKU));
    n.observe(d(SONNET));
    assert.equal(n.take("s"), `reflex downgraded the model: ${OPUS} → ${SONNET}`);
    n.observe(d(HAIKU));
    n.observe(d(SONNET));
    assert.equal(n.take("s"), null);
  });
  it("ignores side calls, subagents and the user's own /model switch", () => {
    const n = new ModelNotices();
    n.observe(d(HAIKU, { turn: "side" }));
    n.observe(d(HAIKU, { agentId: "a", kind: "subagent" }));
    assert.equal(n.take("s"), null);
    n.observe(d(OPUS));
    n.observe(d(SONNET, { requestedModel: SONNET }));
    assert.equal(n.take("s"), null);
  });
  it("a change stays queued when the user switches models before the next hook", () => {
    // Seen in a real session: Haiku upgraded to Opus, then /model sonnet before any main-chat hook fired.
    const n = new ModelNotices();
    n.observe(d(OPUS, { requestedModel: HAIKU }));
    n.observe(d(SONNET, { requestedModel: SONNET, turn: "continuation" }));
    assert.equal(n.take("s"), `reflex upgraded the model: ${HAIKU} → ${OPUS}`);
    n.observe(d(OPUS, { requestedModel: HAIKU }));
    n.observe(d(HAIKU, { requestedModel: SONNET }));
    assert.equal(n.take("s"), `reflex upgraded the model: ${HAIKU} → ${OPUS}\nreflex downgraded the model: ${SONNET} → ${HAIKU}`);
  });
});
