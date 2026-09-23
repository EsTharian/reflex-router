// Route mode end to end: real front door + supervisor + worker, fake upstream, fake Jev, captured fixtures.
// Each describe block uses its own session ids so pins, overrides and disabled tiers never leak between cases.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import zlib from "node:zlib";
import { DEFAULT_MODELS } from "../../src/config.js";
import { DECISION_GRACE_MS } from "../../src/timing.js";
import { startFakeJev, type FakeJev } from "../support/fake-jev.js";
import { loadFixtures, type Fixture } from "../support/fixtures.js";
import { request } from "../support/http.js";
import { replay, requestHeaders, sseHandler } from "../support/replay.js";
import { startStack, type Stack } from "../support/stack.js";

type Json = Record<string, unknown>;
const HAIKU = "claude-haiku-4-5-20251001";
const fixtures = loadFixtures();
const fx = (name: string): Fixture => {
  const f = fixtures.find((x) => x.file === `interactive.${name}.request.json`);
  assert.ok(f, name);
  return f;
};

/** The same fixture in another session: header and metadata.user_id change together, so the shape check still passes. */
function inSession(f: Fixture, sid: string, mutate?: (b: Json) => void): Fixture {
  const b = JSON.parse(f.body.toString()) as Json;
  const md = b["metadata"] as { user_id: string };
  md.user_id = JSON.stringify({ ...(JSON.parse(md.user_id) as Json), session_id: sid });
  mutate?.(b);
  return { ...f, headers: { ...f.headers, "x-claude-code-session-id": sid }, body: Buffer.from(JSON.stringify(b)) };
}
/** Prefixes the user's own text (the last text block of the last message) with `prefix`. */
const prefixTask = (prefix: string) => (b: Json): void => {
  const msgs = b["messages"] as { role: string; content: { type: string; text?: string }[] }[];
  const last = [...msgs].reverse().find((m) => m.role === "user")!;
  const block = [...last.content].reverse().find((c) => c.type === "text" && !c.text?.startsWith("<system-reminder>"))!;
  block.text = prefix + block.text!;
};
/** Inserts `token` right after the prompt's opening <pasted_content id=…> tag. */
const insertAfterPasteTag = (token: string) => (b: Json): void => {
  const msgs = b["messages"] as { role: string; content: { type: string; text?: string }[] }[];
  const last = [...msgs].reverse().find((m) => m.role === "user")!;
  const block = last.content.find((c) => c.type === "text" && /^\s*<pasted_content id="[^"]*">/.test(c.text ?? ""))!;
  block.text = block.text!.replace(/^(\s*<pasted_content id="[^"]*">)/, `$1${token}`);
};
const sentBody = (stack: Stack, i: number): Json => JSON.parse(stack.upstream.seen[i]!.body.toString()) as Json;

interface Timing {
  decision_wait_ms: number;
  decision_deadline_ms: number;
  upstream_first_byte_ms: number | null;
}
const timingOf = (rec: object): Timing => (rec as { timing: Timing }).timing;

describe("route mode", () => {
  let jev: FakeJev;
  let stack: Stack;
  before(async () => {
    jev = await startFakeJev({ kind: "answer", tier: "haiku", confidence: 0.9, reasoning: 0.4 });
    stack = await startStack({ effectiveMode: "route", config: { mode: "route", jevBaseUrl: jev.url, jevDeadlineMs: 500 } });
  });
  after(async () => {
    await stack.close();
    await jev.close();
  });
  beforeEach(() => {
    stack.upstream.setHandler(sseHandler);
    jev.set({ kind: "answer", tier: "haiku", confidence: 0.9, reasoning: 0.4 });
  });

  describe("subagents", () => {
    it("the first request is decided and rewritten to Haiku; the record lists requested model, rewritten model and fields", async () => {
      const n = stack.upstream.seen.length;
      const { status, rec } = await replay(stack, inSession(fx("subagent-new-turn"), "s-sub"));
      assert.equal(status, 200);
      const b = sentBody(stack, n);
      assert.equal(b["model"], HAIKU);
      assert.equal(b["output_config"], undefined);
      assert.equal((b["thinking"] as Json)["type"], "enabled");
      assert.ok(!(b["messages"] as Json[]).some((m) => m["role"] === "system"));
      assert.equal(rec.mode_effective, "route");
      assert.equal(rec.pin, "set");
      assert.deepEqual(rec.forwarded, { requested_model: "claude-sonnet-5", model: HAIKU, rewritten: true, fields: ["model", "output_config.effort", "thinking", "messages.system_folded:1"], fallback: false, fallback_status: null, fallback_error: null });
      assert.equal(rec.plan?.routed_to, HAIKU);
    });

    it("its continuation reuses the pin (same agent id) with zero Jev calls", async () => {
      const calls = jev.calls.length;
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, inSession(fx("subagent-continuation"), "s-sub"));
      assert.equal(jev.calls.length, calls);
      assert.equal(sentBody(stack, n)["model"], HAIKU);
      assert.equal(rec.pin, "hit");
      assert.equal(rec.forwarded.rewritten, true);
    });

    it("every record carries a timing breakdown: a decided new turn waited for the backend, a continuation did not", async () => {
      const first = await replay(stack, inSession(fx("subagent-new-turn"), "s-timing"));
      const cont = await replay(stack, inSession(fx("subagent-continuation"), "s-timing"));
      const a = timingOf(first.rec);
      assert.equal(a.decision_deadline_ms, 500);
      assert.ok(a.decision_wait_ms >= 0 && a.decision_wait_ms < 500 + DECISION_GRACE_MS, `waited ${a.decision_wait_ms} ms`);
      assert.ok(a.upstream_first_byte_ms !== null && a.upstream_first_byte_ms >= 0);
      const b = timingOf(cont.rec);
      assert.equal(b.decision_wait_ms, 0, "a pinned continuation never waits for the backend");
      assert.ok(b.upstream_first_byte_ms !== null);
    });

    it("the subagent's harness side call passes through unchanged even though the agent is pinned", async () => {
      const f = inSession(fx("subagent-summary"), "s-sub");
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, f);
      assert.ok(stack.upstream.seen[n]!.body.equals(f.body));
      assert.equal(rec.turn, "side");
      assert.equal(rec.forwarded.rewritten, false);
    });

    it("a continuation with no pin (unknown agent / restarted worker) goes out unchanged: pin miss", async () => {
      const f = inSession(fx("subagent-continuation"), "s-nopin");
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, f);
      assert.ok(stack.upstream.seen[n]!.body.equals(f.body));
      assert.equal(rec.pin, "miss");
    });
  });

  describe("main chat behind the cost guard", () => {
    it("a fresh conversation's first turn may be routed (nothing is cached yet); its continuation follows the pin", async () => {
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, inSession(fx("main-new-turn"), "s-main"));
      assert.equal(sentBody(stack, n)["model"], HAIKU);
      assert.deepEqual(rec.guard, { allowed: true, reason: "fresh", ctx: null, penalty_usd: null });
      const c = await replay(stack, inSession(fx("main-continuation"), "s-main"));
      assert.equal(c.rec.pin, "hit");
      assert.equal(sentBody(stack, n + 1)["model"], HAIKU);
    });

    it("a later turn with unknown context is refused before the backend is asked", async () => {
      const calls = jev.calls.length;
      const f = inSession(fx("main-new-turn-plain"), "s-guard");
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, f);
      assert.equal(jev.calls.length, calls, "no Jev call when no target could pass the guard");
      assert.ok(stack.upstream.seen[n]!.body.equals(f.body));
      assert.equal(rec.guard?.reason, "ctx_unknown");
      assert.deepEqual(rec.plan?.reasons, ["guard_blocked"]);
    });

    it("a later turn whose measured context makes the switch too expensive is refused (over_limit), without asking Jev", async () => {
      // Turn 1: Jev keeps Sonnet, and the response reports a 200k-token prompt (all cache writes on Sonnet).
      jev.set({ kind: "answer", tier: "sonnet", confidence: 0.9, reasoning: 2 });
      stack.upstream.setHandler((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_creation_input_tokens":200000,"cache_read_input_tokens":0,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n');
      });
      const first = await replay(stack, inSession(fx("main-new-turn"), "s-big"));
      assert.deepEqual(first.rec.plan?.reasons, ["same_tier"]);
      // Turn 2 in the same conversation: a switch to Haiku would rewrite 200k tokens into a new 1h cache.
      jev.set({ kind: "answer", tier: "haiku", confidence: 0.99, reasoning: 0.1 });
      const calls = jev.calls.length;
      const f = inSession(fx("main-new-turn-plain"), "s-big");
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, f);
      assert.equal(jev.calls.length, calls);
      assert.ok(stack.upstream.seen[n]!.body.equals(f.body));
      assert.equal(rec.guard?.reason, "over_limit");
      assert.equal(rec.guard?.ctx, 200005);
      assert.ok((rec.guard?.penalty_usd ?? 0) > 0.3);
    });
  });

  describe("model-change notice", () => {
    const hook = (sid: string, event: Json) =>
      request(`${stack.url}/__reflex/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sid, ...event }) });

    it("the next main-chat hook after a rewrite carries a systemMessage, once; subagent hooks never do", async () => {
      await replay(stack, inSession(fx("main-new-turn"), "s-notice"));
      assert.equal((await hook("s-notice", { hook_event_name: "Stop", agent_id: "A1" })).status, 204, "a subagent's hook");
      const r = await hook("s-notice", { hook_event_name: "Stop" });
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.body.toString()), { systemMessage: `reflex downgraded the model: claude-sonnet-5 → ${HAIKU}` });
      assert.equal((await hook("s-notice", { hook_event_name: "Stop" })).status, 204, "delivered once");
      await replay(stack, inSession(fx("main-continuation"), "s-notice"));
      assert.equal((await hook("s-notice", { hook_event_name: "Stop" })).status, 204, "still on Haiku: nothing new");
    });
  });

  describe("Opus sessions (verified: Opus -> Sonnet, Opus -> Haiku)", () => {
    const opus = (b: Json): void => {
      b["model"] = "claude-opus-5";
    };
    it("a subagent Jev judges sonnet-level goes to Sonnet with only the model swapped; its continuation follows", async () => {
      jev.set({ kind: "answer", tier: "sonnet", confidence: 0.9, reasoning: 2 });
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, inSession(fx("subagent-new-turn"), "s-opus1", opus));
      assert.deepEqual(rec.forwarded, { requested_model: "claude-opus-5", model: "claude-sonnet-5", rewritten: true, fields: ["model"], fallback: false, fallback_status: null, fallback_error: null });
      const orig = JSON.parse(inSession(fx("subagent-new-turn"), "s-opus1", opus).body.toString()) as Json;
      assert.deepEqual({ ...sentBody(stack, n), model: "claude-opus-5" }, orig, "nothing but the model changed");
      const c = await replay(stack, inSession(fx("subagent-continuation"), "s-opus1", opus));
      assert.equal(c.rec.pin, "hit");
      assert.equal(sentBody(stack, n + 1)["model"], "claude-sonnet-5");
    });

    it("a subagent Jev judges haiku-level goes to Haiku with the full rewrite", async () => {
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, inSession(fx("subagent-new-turn"), "s-opus2", opus));
      assert.equal(rec.forwarded.model, HAIKU);
      assert.deepEqual(rec.forwarded.fields, ["model", "output_config.effort", "thinking", "messages.system_folded:1"]);
      assert.equal((sentBody(stack, n)["thinking"] as Json)["type"], "enabled");
    });
  });

  describe("opus[1m] sessions: the long-context beta (acceptance session B1)", () => {
    const opus1m = (): Fixture => {
      const f = fixtures.find((x) => x.file === "interactive-opus1m.main-new-turn.request.json");
      assert.ok(f);
      return f;
    };
    it("to Haiku: the beta is removed from anthropic-beta, the rest kept, and the record lists it", async () => {
      jev.set({ kind: "answer", tier: "haiku", confidence: 0.99, reasoning: 0.2 });
      const f = inSession(opus1m(), "s-1m-h");
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, f);
      const sent = String(stack.upstream.seen[n]!.headers["anthropic-beta"]);
      const orig = String(f.headers["anthropic-beta"]);
      assert.doesNotMatch(sent, /context-1m/);
      assert.deepEqual(sent.split(","), orig.split(",").filter((b) => !b.startsWith("context-1m-")));
      assert.ok(rec.forwarded.fields.includes("anthropic-beta:-context-1m-2025-08-07"));
      assert.equal(stack.upstream.seen[n]!.headers["authorization"], f.headers["authorization"], "credentials untouched");
    });

    it("to Sonnet: headers untouched", async () => {
      jev.set({ kind: "answer", tier: "sonnet", confidence: 0.9, reasoning: 2 });
      const f = inSession(opus1m(), "s-1m-s");
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, f);
      assert.equal(stack.upstream.seen[n]!.headers["anthropic-beta"], f.headers["anthropic-beta"]);
      assert.deepEqual(rec.forwarded.fields, ["model"]);
    });

    it("a rejected Haiku rewrite is retried with the original headers, beta included", async () => {
      jev.set({ kind: "answer", tier: "haiku", confidence: 0.99, reasoning: 0.2 });
      stack.upstream.setHandler((req, res, body) => {
        if (body.toString().includes(HAIKU)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "x" } }));
          return;
        }
        sseHandler(req, res, body);
      });
      const f = inSession(opus1m(), "s-1m-fb");
      const n = stack.upstream.seen.length;
      await replay(stack, f);
      assert.equal(stack.upstream.seen[n + 1]!.headers["anthropic-beta"], f.headers["anthropic-beta"]);
      assert.ok(stack.upstream.seen[n + 1]!.body.equals(f.body));
    });
  });

  describe("manual overrides", () => {
    it("`reflex:haiku` inside a pasted prompt bypasses Jev; a subagent spawned in that turn records it at its first request", async () => {
      const calls = jev.calls.length;
      // The fixture's prompt is wrapped in <pasted_content id="ec1f">…; the token follows the opening tag.
      const main = await replay(stack, inSession(fx("main-new-turn"), "s-ovr", insertAfterPasteTag("reflex:haiku ")));
      assert.equal(main.rec.override, "haiku");
      assert.deepEqual(main.rec.plan?.reasons, ["override"]);
      const n = stack.upstream.seen.length;
      const sub = await replay(stack, inSession(fx("subagent-new-turn"), "s-ovr"));
      assert.equal(jev.calls.length, calls, "overrides never ask the backend");
      assert.equal(sub.rec.override, "haiku");
      assert.equal(sentBody(stack, n)["model"], HAIKU);
    });

    it("an override up to Opus 5.5 (the opus default) is not applied while its pairs are unverified", async () => {
      const f = inSession(fx("main-new-turn"), "s-ovr2", prefixTask("reflex:opus "));
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, f);
      assert.equal(sentBody(stack, n)["model"], "claude-sonnet-5");
      assert.deepEqual(rec.plan?.reasons, ["override", "rewrite_unverified"]);
      assert.equal(rec.forwarded.rewritten, false);
    });
  });

  describe("safety nets", () => {
    it("a rejected rewrite is retried once with the original bytes; the tier is then disabled for the session", async () => {
      stack.upstream.setHandler((req, res, body) => {
        if (body.toString().includes(HAIKU)) {
          const err = zlib.gzipSync(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "nope" } }));
          res.writeHead(400, { "content-type": "application/json", "content-encoding": "gzip" });
          res.end(err);
          return;
        }
        sseHandler(req, res, body);
      });
      const f = inSession(fx("subagent-new-turn"), "s-rej");
      const n = stack.upstream.seen.length;
      const { status, rec } = await replay(stack, f);
      assert.equal(status, 200, "the client sees the original request's answer");
      assert.equal(stack.upstream.seen.length, n + 2);
      assert.equal(sentBody(stack, n)["model"], HAIKU);
      assert.ok(stack.upstream.seen[n + 1]!.body.equals(f.body), "the retry is the original bytes");
      assert.equal(rec.forwarded.fallback, true);
      assert.equal(rec.forwarded.fallback_status, 400);
      assert.equal(rec.forwarded.fallback_error, "invalid_request_error: nope", "the upstream's error is kept (redacted)");
      assert.match(typeof rec["drift"] === "string" ? rec["drift"] : "", /(^|,)rewrite_rejected(,|$)/, "a rejected rewrite is wire drift in section 1");
      assert.equal(rec.forwarded.model, "claude-sonnet-5");

      const again = await replay(stack, inSession(fx("subagent-new-turn"), "s-rej", (b) => ((b["messages"] as Json[]).length = 1)));
      assert.ok(again.rec.plan?.reasons.includes("tier_disabled"));
      assert.equal(again.rec.forwarded.rewritten, false);
    });

    it("a rewrite rejected as too long for the target is retried with the original, and the tier stays enabled", async () => {
      stack.upstream.setHandler((req, res, body) => {
        if (body.toString().includes(HAIKU)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 244258 tokens > 200000 maximum" } }));
          return;
        }
        sseHandler(req, res, body);
      });
      const f = inSession(fx("subagent-new-turn"), "s-long");
      const n = stack.upstream.seen.length;
      const { status, rec } = await replay(stack, f);
      assert.equal(status, 200);
      assert.ok(stack.upstream.seen[n + 1]!.body.equals(f.body), "the retry is the original bytes");
      assert.equal(rec.forwarded.fallback_status, 400);

      stack.upstream.setHandler(sseHandler);
      const again = await replay(stack, inSession(fx("subagent-new-turn"), "s-long", (b) => ((b["messages"] as Json[]).length = 1)));
      assert.ok(!again.rec.plan?.reasons.includes("tier_disabled"), "a size rejection does not disable Haiku for the session");
      assert.equal(again.rec.forwarded.model, HAIKU);
    });

    it("a hanging backend fails open within the deadline: unchanged bytes, and the loop stays on the requested model", async () => {
      jev.set({ kind: "hang" });
      const f = inSession(fx("subagent-new-turn"), "s-hang");
      const n = stack.upstream.seen.length;
      const { rec, ms } = await replay(stack, f);
      assert.ok(ms < 500 + 250 + 400, `took ${ms} ms`);
      assert.ok(stack.upstream.seen[n]!.body.equals(f.body));
      assert.equal(rec.error, "backend:timeout");
      // The timing breakdown is what shows, from the log alone, that the wait stayed within the deadline.
      const t = timingOf(rec);
      assert.equal(t.decision_deadline_ms, 500);
      assert.ok(t.decision_wait_ms >= 450 && t.decision_wait_ms <= 500 + DECISION_GRACE_MS, `decision waited ${t.decision_wait_ms} ms`);
      assert.ok(t.upstream_first_byte_ms !== null && t.upstream_first_byte_ms >= 0);
      const ttfb = (rec["upstream"] as { msToHeaders: number }).msToHeaders;
      assert.ok(ttfb >= t.decision_wait_ms + t.upstream_first_byte_ms && ttfb - (t.decision_wait_ms + t.upstream_first_byte_ms) < 100, "msToHeaders = decision wait + router work + upstream first byte");
      const c = inSession(fx("subagent-continuation"), "s-hang");
      const cont = await replay(stack, c);
      assert.equal(cont.rec.pin, "hit");
      assert.ok(stack.upstream.seen[n + 1]!.body.equals(c.body));
    });

    it("a shape violation stops routing for the session (records say shadow)", async () => {
      const f = inSession(fx("subagent-new-turn"), "s-shape");
      const bad = { ...f, headers: { ...f.headers, "x-claude-code-session-id": "s-shape-other" } };
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, bad);
      assert.ok(stack.upstream.seen[n]!.body.equals(bad.body));
      assert.equal(rec.mode_effective, "shadow");
      assert.match(String(rec["degraded_reason"]), /shape:session_id/);
    });

    it("the TypeSafe key never reaches the upstream in route mode either", () => {
      for (const s of stack.upstream.seen) assert.doesNotMatch(JSON.stringify(s.headers) + s.body.toString(), /apikey_test/);
      assert.ok(stack.upstream.seen.every((s) => s.headers["authorization"] === requestHeaders(fx("main-new-turn"))["authorization"] || s.headers["authorization"] === undefined));
    });
  });
});

describe("route mode: upgrades (REFLEX_UPGRADES=on, verified Haiku -> Opus)", () => {
  let jev: FakeJev;
  let stack: Stack;
  before(async () => {
    jev = await startFakeJev({ kind: "answer", tier: "opus", confidence: 0.9, reasoning: 4 });
    // Opus 5 (verified), not the Opus 5.5 default (unverified): this suite is about the upgrade path itself.
    stack = await startStack({ effectiveMode: "route", config: { mode: "route", upgrades: "on", jevBaseUrl: jev.url, jevDeadlineMs: 500, models: { ...DEFAULT_MODELS, opus: "claude-opus-5" } } });
    stack.upstream.setHandler(sseHandler);
  });
  after(async () => {
    await stack.close();
    await jev.close();
  });

  it("a Haiku main-chat turn the backend wants on Opus is rewritten, and the chat is told", async () => {
    const f = inSession(fixtures.find((x) => x.file === "haiku-mcp-draft4.main-new-turn.request.json")!, "s-up");
    const n = stack.upstream.seen.length;
    const { rec } = await replay(stack, f);
    const b = sentBody(stack, n);
    assert.equal(b["model"], "claude-opus-5");
    assert.equal((b["thinking"] as Json)["type"], "adaptive");
    assert.deepEqual(rec.plan?.reasons, ["upgrade"]);
    assert.equal(rec.forwarded.rewritten, true);
    const r = await request(`${stack.url}/__reflex/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: "s-up", hook_event_name: "Stop" }) });
    assert.deepEqual(JSON.parse(r.body.toString()), { systemMessage: "reflex upgraded the model: claude-haiku-4-5-20251001 → claude-opus-5" });
  });
});
