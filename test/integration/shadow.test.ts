// Shadow mode end to end: real front door + supervisor + worker process, fake upstream, fake Jev. Every captured
// fixture is replayed: the upstream must see identical bytes, only positively identified `new` turns may reach Jev,
// and every classified request leaves exactly one record in decisions.jsonl.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startFakeJev, type FakeJev } from "../support/fake-jev.js";
import { loadFixtures, type Fixture } from "../support/fixtures.js";
import { request, waitFor } from "../support/http.js";
import { records, replay, requestHeaders, sseHandler, USAGE } from "../support/replay.js";
import { startStack, type Stack } from "../support/stack.js";

const fixtures = loadFixtures();
const expectsDecision = (fx: Fixture): boolean => fx.expect.turn === "new" && fx.expect.kind !== "unknown";

describe("shadow mode, end to end", () => {
  let jev: FakeJev;
  let stack: Stack;
  before(async () => {
    jev = await startFakeJev({ kind: "answer", tier: "haiku", confidence: 0.9, reasoning: 0.4 });
    stack = await startStack({ config: { jevBaseUrl: jev.url, jevDeadlineMs: 800 } });
    stack.upstream.setHandler(sseHandler);
  });
  after(async () => {
    await stack.close();
    await jev.close();
  });

  it("replays every fixture: identical bytes upstream, one record each, Jev only for `new` turns", async () => {
    for (const fx of fixtures) {
      const seenBefore = stack.upstream.seen.length;
      const callsBefore = jev.calls.length;
      const { status, rec } = await replay(stack, fx);
      assert.equal(status, 200, fx.file);
      const seen = stack.upstream.seen[seenBefore];
      assert.ok(seen && seen.body.equals(fx.body), `${fx.file}: upstream must receive the original bytes`);
      assert.equal(rec.turn, fx.expect.turn, fx.file);
      assert.equal(rec.side_kind, fx.expect.side_kind ?? null, fx.file);
      assert.equal(rec["kind"], fx.expect.kind, fx.file);
      assert.equal(rec["mode_effective"], "shadow");
      assert.deepEqual((rec["forwarded"] as { rewritten: boolean }).rewritten, false);
      assert.deepEqual(rec["usage"], USAGE, `${fx.file}: usage read from the gzip response`);
      assert.deepEqual(rec["shape"], { status: (rec["shape"] as { status: string }).status, violations: [] });
      if (expectsDecision(fx)) {
        assert.equal(jev.calls.length, callsBefore + 1, `${fx.file}: one Jev call`);
        assert.ok(rec.decision, fx.file);
        assert.ok(rec.plan, fx.file);
        assert.equal(rec.error, null);
        assert.ok(typeof rec["prompt_preview"] === "string" && Array.from(rec["prompt_preview"]).length <= 300);
      } else {
        assert.equal(jev.calls.length, callsBefore, `${fx.file}: side/continuation must not call Jev`);
        assert.equal(rec.decision, null);
        assert.equal("prompt_preview" in rec, false);
      }
    }
  });

  it("a subagent downgrade is recorded as would-route, and the request still goes out unchanged", async () => {
    const fx = fixtures.find((f) => f.file === "interactive.subagent-new-turn.request.json");
    assert.ok(fx);
    const { rec } = await replay(stack, fx);
    assert.equal(rec.plan?.would_route_to, "claude-haiku-4-5-20251001");
    assert.deepEqual(rec.plan?.reasons, ["downgrade"]);
    assert.equal(rec.plan?.routed_to, "claude-sonnet-5");
    assert.equal(rec["signal"], "header");
    const d = rec.decision as { rule: string; pick_mass: { value: string; above_mass: number }; pick_argmax: { value: string; confidence: number } };
    assert.equal(d.rule, "mass");
    assert.deepEqual(d.pick_mass, { value: "haiku", above_mass: 0.1 });
    assert.deepEqual(d.pick_argmax, { value: "haiku", confidence: 0.9 });
  });

  it("Jev sees only the allow-listed state keys, and nothing that identifies the session or the machine", () => {
    assert.ok(jev.calls.length > 0);
    for (const call of jev.calls) {
      const state = call.body.state as Record<string, unknown>;
      for (const k of Object.keys(state)) assert.ok(["task", "previous_assistant_reply", "context"].includes(k), k);
      assert.deepEqual(Object.keys(state["context"] as object).sort(), ["is_subagent", "requesting_tier"]);
      assert.doesNotMatch(call.raw, /SESSION-|AGENT-|DEVICE-|ACCOUNT-|x-anthropic-billing-header|\/Users\//);
      assert.equal(call.headers.authorization, "Bearer apikey_test", "only the TypeSafe key goes to Jev");
    }
  });

  it("the TypeSafe key never reaches the upstream, and the upstream gets only decodable codings", () => {
    for (const s of stack.upstream.seen) {
      assert.doesNotMatch(JSON.stringify(s.headers) + s.body.toString(), /apikey_test/);
      const ae = s.headers["accept-encoding"];
      if (ae !== undefined) assert.doesNotMatch(String(ae), /zstd/);
    }
    const interactive = stack.upstream.seen.find((s) => String(s.headers["user-agent"]).includes("(external, cli)"));
    assert.equal(interactive?.headers["accept-encoding"], "gzip, deflate, br");
  });

  it("a zstd response is passed through untouched and recorded as usage unknown", async () => {
    const payload = Buffer.from("zstd-bytes-the-proxy-cannot-decode");
    stack.upstream.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "zstd" });
      res.end(payload);
    });
    try {
      const fx = fixtures.find((f) => f.expect.turn === "continuation");
      assert.ok(fx);
      const before = records(stack).length;
      const r = await request(`${stack.url}/v1/messages`, { method: "POST", headers: requestHeaders(fx), body: fx.body });
      assert.ok(r.body.equals(payload));
      const rec = (await waitFor(() => (records(stack).length > before ? records(stack) : null)))[before]!;
      assert.equal(rec["usage"], null);
      assert.equal(rec["usage_unknown_reason"], "encoding:zstd");
    } finally {
      stack.upstream.setHandler(sseHandler);
    }
  });

  it("a shape violation degrades the session to shadow with the check name, and nothing else changes", async () => {
    const fx = fixtures.find((f) => f.file === "interactive.main-continuation.request.json");
    assert.ok(fx);
    const headers = { ...requestHeaders(fx), "x-claude-code-session-id": "a-different-session" };
    const { status, rec } = await replay(stack, fx, fx.body, headers);
    assert.equal(status, 200);
    assert.equal(rec["degraded_reason"], "shape:session_id");
    assert.deepEqual(rec["shape"], { status: "degraded", violations: ["session_id"] });
  });

  it("the startup probe and count_tokens are forwarded but never classified or logged", async () => {
    const before = records(stack).length;
    await request(`${stack.url}/api/hello`, { method: "HEAD" });
    await request(`${stack.url}/v1/messages/count_tokens?beta=true`, { method: "POST", body: fixtures[0]!.body });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(records(stack).length, before);
  });
});

describe("shadow mode: the decision backend failing never touches the session", () => {
  let jev: FakeJev;
  let stack: Stack;
  const newTurn = fixtures.find((f) => f.file === "interactive.main-new-turn.request.json");
  before(async () => {
    jev = await startFakeJev({ kind: "hang" });
    stack = await startStack({ config: { jevBaseUrl: jev.url, jevDeadlineMs: 600 } });
    stack.upstream.setHandler(sseHandler);
  });
  after(async () => {
    await stack.close();
    await jev.close();
  });

  it("a hanging backend adds no latency: the response arrives long before the backend deadline", async () => {
    assert.ok(newTurn);
    const { status, rec, ms } = await replay(stack, newTurn);
    assert.equal(status, 200);
    assert.ok(ms < 400, `response took ${ms} ms`);
    assert.equal(rec.error, "backend:timeout");
    assert.equal(rec.decision, null);
    assert.deepEqual(rec["usage"], USAGE, "the response is still measured");
  });

  it("HTTP errors and junk are recorded by category; the upstream still sees the original bytes", async () => {
    assert.ok(newTurn);
    for (const [b, err] of [[{ kind: "status", status: 500 }, "backend:http:500"], [{ kind: "junk" }, "backend:invalid_response"]] as const) {
      jev.set(b);
      const seenBefore = stack.upstream.seen.length;
      const { rec } = await replay(stack, newTurn);
      assert.equal(rec.error, err);
      assert.ok(stack.upstream.seen[seenBefore]?.body.equals(newTurn.body));
    }
  });

  it("after 3 consecutive failures the breaker opens and Jev is not called at all", async () => {
    assert.ok(newTurn);
    const calls = jev.calls.length; // three failures so far: timeout, 500, junk
    const { rec } = await replay(stack, newTurn);
    assert.equal(rec.error, "breaker_open");
    assert.equal(jev.calls.length, calls);
  });
});
