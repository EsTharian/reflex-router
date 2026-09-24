// REFLEX_EFFORT: the level rule, the wire edits (add, re-insert by history hash, top-level) and the store, then the
// router end to end on an Opus 5.5 conversation (docs/wire-format.md §5.8).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { DecisionBackend } from "../../src/backend/types.js";
import { loadConfig } from "../../src/config.js";
import { DecisionLog, type DecisionRecord } from "../../src/log/decision-log.js";
import { effortPlan } from "../../src/policy.js";
import type { Decision, Effort } from "../../src/types.js";
import { Breaker } from "../../src/worker/breaker.js";
import { EffortStore } from "../../src/worker/effort-store.js";
import { Router } from "../../src/worker/router.js";
import { effortVia, withEffort, withTopEffort } from "../../src/wire/effort.js";
import { loadFixtures } from "../support/fixtures.js";
import { waitFor } from "../support/http.js";

type Json = Record<string, unknown>;
type Msg = { role: string; content: unknown; output_config?: { effort: string } };
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "reflex-effort-"));
const msgs = (b: Buffer): Msg[] => (JSON.parse(b.toString()) as { messages: Msg[] }).messages;
const top = (b: Buffer): unknown => (JSON.parse(b.toString()) as { output_config?: { effort?: string } }).output_config?.effort;
const model = (b: Buffer): unknown => (JSON.parse(b.toString()) as { model?: string }).model;
const shape = (b: Buffer): string => msgs(b).map((m) => m.role[0]! + (m.output_config ? `:${m.output_config.effort}` : "")).join(" ");

describe("effortPlan: reasoning_demand read as a level", () => {
  it("one level per step of the 0..4 scale, absolute, clamped to the client's level unless up", () => {
    assert.deepEqual(effortPlan(0.2, "high", false), { pick: "low", target: "low", reasons: ["effort_down"] });
    assert.deepEqual(effortPlan(1.6, "high", false), { pick: "high", target: "high", reasons: ["effort_same"] });
    assert.deepEqual(effortPlan(3.9, "medium", false), { pick: "max", target: "medium", reasons: ["effort_up_disabled"] });
    assert.deepEqual(effortPlan(3.9, "medium", true), { pick: "max", target: "max", reasons: ["effort_up"] });
    assert.deepEqual(effortPlan(-3, "low", true), { pick: "low", target: "low", reasons: ["effort_same"] });
    assert.deepEqual(effortPlan(2, null, true), { pick: "high", target: null, reasons: ["effort_requested_unknown"] });
    assert.equal(effortPlan(undefined, "high", true), null);
  });
});

describe("effort on the wire", () => {
  // Claude Code's shape: the new turn ends in the index-1 system message carrying the session's effort; on the next
  // request the same content comes back as a string, cache_control has moved, and the turn's reply follows.
  const first = { model: "claude-opus-5-5", output_config: { effort: "high" }, messages: [
    { role: "user", content: [{ type: "text", text: "do the thing", cache_control: { type: "ephemeral" } }] },
    { role: "system", content: [{ type: "text", text: "reminders" }], output_config: { effort: "high" } },
  ] };
  const next = { ...first, messages: [
    { role: "user", content: [{ type: "text", text: "do the thing" }] },
    { role: "system", content: "reminders", output_config: { effort: "high" } },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "now the other", cache_control: { type: "ephemeral" } }] },
  ] };
  const buf = (o: unknown): Buffer => Buffer.from(JSON.stringify(o));

  it("adds Claude Code's effort-only message after the new turn and sets the top-level value", () => {
    const e = withEffort(buf(first), () => undefined, "low")!;
    assert.equal(shape(e.body), "u s:high s:low");
    assert.deepEqual(msgs(e.body).at(-1), { role: "system", content: [], output_config: { effort: "low" } });
    assert.equal(top(e.body), "low");
    assert.deepEqual(e.fields, ["messages.effort_added", "output_config.effort"]);
    assert.match(e.added!.anchor, /^[0-9a-f]{64}$/);
  });

  it("re-inserts it on later requests at the same place, whatever cache_control and string/block form do", () => {
    const a = withEffort(buf(first), () => undefined, "low")!;
    const store = new Map<string, Effort>([[a.added!.anchor, "low"]]);
    const e = withEffort(buf(next), (h) => store.get(h), null)!;
    assert.equal(shape(e.body), "u s:high s:low a u");
    assert.equal(top(e.body), "low");
    assert.deepEqual(e.fields, ["messages.effort_reinserted:1", "output_config.effort"]);
    assert.equal(e.added, null);
  });

  it("a new level on a later turn goes at its end; the level already in effect is not added twice", () => {
    const a = withEffort(buf(first), () => undefined, "low")!;
    const store = new Map<string, Effort>([[a.added!.anchor, "low"]]);
    assert.equal(shape(withEffort(buf(next), (h) => store.get(h), "max")!.body), "u s:high s:low a u s:max");
    const same = withEffort(buf(next), (h) => store.get(h), "low")!;
    assert.equal(same.added, null);
    assert.equal(shape(same.body), "u s:high s:low a u");
    // back to the client's own level: a message saying so, since the history still holds "low"
    assert.equal(shape(withEffort(buf(next), (h) => store.get(h), "high")!.body), "u s:high s:low a u s:high");
  });

  it("nothing stored and nothing to add: the very same bytes (byte-identical passthrough)", () => {
    const b = buf(next);
    assert.equal(withEffort(b, () => undefined, null)!.body, b);
    assert.equal(withEffort(b, () => undefined, "high")!.body, b, "high is already in effect");
    assert.equal(withEffort(Buffer.from("not json"), () => undefined, "low"), null);
  });

  it("the client's own later /effort message is the level in effect", () => {
    const withOwn = { ...next, messages: [...next.messages, { role: "system", content: [], output_config: { effort: "max" } }] };
    assert.equal(withEffort(buf(withOwn), () => undefined, "max")!.added, null);
  });

  it("Sonnet: top-level only; Opus 5.5: by message; Opus 5, Fable and Haiku: not at all", () => {
    assert.equal(effortVia("claude-opus-5-5", false), "message");
    assert.equal(effortVia("claude-sonnet-5", true), "top-level");
    assert.equal(effortVia("claude-sonnet-5", false), null, "a top-level change rewrites Sonnet's whole cache");
    for (const m of ["claude-opus-5", "claude-fable-5-1", "claude-haiku-4-5-20251001"]) assert.equal(effortVia(m, true), null, m);
    const b = buf(first);
    assert.equal(top(withTopEffort(b, "max")!.body), "max");
    assert.equal(withTopEffort(b, "high")!.body, b);
  });
});

describe("EffortStore", () => {
  it("keeps anchors across instances, skips bad lines, writes hashes and levels only", () => {
    const home = tmp();
    const a = "a".repeat(64);
    EffortStore.at(home, () => undefined).add(a, "low");
    fs.appendFileSync(path.join(home, "effort.jsonl"), "torn{\n" + JSON.stringify({ anchor: "short", effort: "low" }) + "\n" + JSON.stringify({ anchor: "b".repeat(64), effort: "huge" }) + "\n");
    const again = EffortStore.at(home, () => undefined);
    assert.equal(again.get(a), "low");
    assert.equal(again.get("b".repeat(64)), undefined);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(home, "effort.jsonl"), "utf8").split("\n")[0]!) as Json).sort(), ["anchor", "at", "effort", "v"]);
    assert.equal(fs.statSync(path.join(home, "effort.jsonl")).mode & 0o777, 0o600);
  });
});

describe("router: REFLEX_EFFORT on an Opus 5.5 conversation", () => {
  const fx = loadFixtures();
  const get = (name: string): { headers: Json; body: Json } => {
    const f = fx.find((x) => x.version === "2.1.280" && x.file === `print-agent.${name}.request.json`)!;
    return { headers: f.headers, body: JSON.parse(f.body.toString()) as Json };
  };
  const newTurn = get("main-new-turn");
  // The fixtures elide long text differently per request, so the continuation is built on the new turn's own
  // messages: the history Claude Code would really send back.
  const contBody = { ...get("main-continuation").body, messages: [...(newTurn.body["messages"] as unknown[]), ...(get("main-continuation").body["messages"] as unknown[]).slice(2)] };

  function harness(env: Record<string, string>, demand: number, home = tmp(), tier: "opus" | "sonnet" = "opus") {
    const loaded = loadConfig({ REFLEX_MODE: "route", TYPESAFE_API_KEY: "apikey_x", REFLEX_HOME: home, REFLEX_JEV_DEADLINE_MS: "200", ...env });
    assert.ok(loaded.ok);
    const backend: DecisionBackend = {
      id: "jev",
      decide: () =>
        Promise.resolve<Decision>({
          answers: {
            tier: { type: "choice", choice: tier, confidence: 0.9, probabilities: { haiku: 0, sonnet: tier === "sonnet" ? 1 : 0, opus: tier === "opus" ? 1 : 0 } },
            reasoning_demand: { type: "score", score: demand, confidence: 0.9, probabilities: {} },
          },
          latencyMs: 1,
          backendModel: "jev-test",
          tokensIn: 1,
          connection: "reused",
        }),
    };
    const log = new DecisionLog(home, false);
    const store = EffortStore.at(home, () => undefined);
    const router = new Router({ config: loaded.config, effectiveMode: "route", degradedReason: null, claudeVersion: "2.1.280", backend, breaker: new Breaker(), log, logger: () => undefined, effortStore: store });
    const records = (): DecisionRecord[] => (fs.existsSync(log.file) ? fs.readFileSync(log.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as DecisionRecord) : []);
    return {
      home,
      async send(req: { headers: Json; body: Json }, status = 200) {
        const before = records().length;
        const p = await router.prepare("POST", "/v1/messages?beta=true", req.headers as never, Buffer.from(JSON.stringify(req.body)));
        assert.ok(p.obs);
        if (status !== 200) p.obs.fallback(status, "rejected");
        p.obs.headers(200, { "content-type": "text/event-stream" });
        p.obs.tap(Buffer.from(`event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_creation_input_tokens":0,"cache_read_input_tokens":40000,"output_tokens":1}}}\n\n`));
        p.obs.finish(true);
        const all = await waitFor(() => (records().length > before ? records() : null));
        return { rec: all[before]!, sent: p.body, rewritten: p.rewritten };
      },
    };
  }

  it("an easy turn runs at low: effort message added, recorded, and re-inserted on the continuation", async () => {
    const h = harness({ REFLEX_EFFORT: "1" }, 0);
    const a = await h.send(newTurn);
    assert.equal(a.rewritten, true);
    assert.equal(msgs(a.sent).length, 3);
    assert.deepEqual(msgs(a.sent).at(-1), { role: "system", content: [], output_config: { effort: "low" } });
    assert.equal(top(a.sent), "low");
    assert.equal(model(a.sent), "claude-opus-5-5", "the model is left alone");
    assert.deepEqual(a.rec.effort, { pick: "low", target: "low", via: "message", reasons: ["effort_down"] });
    assert.deepEqual(a.rec.forwarded.fields, ["messages.effort_added", "output_config.effort"]);

    const c = await h.send({ headers: newTurn.headers, body: contBody });
    assert.equal(msgs(c.sent)[2]!.output_config?.effort, "low");
    assert.equal(msgs(c.sent)[3]!.role, "assistant");
    assert.ok(c.rec.forwarded.fields.includes("messages.effort_reinserted:1"));

    // a fresh worker (restart, or a resume through reflex) still re-inserts it, even with the setting off now
    const fresh = harness({}, 0, h.home);
    const r = await fresh.send({ headers: newTurn.headers, body: contBody });
    assert.equal(msgs(r.sent)[2]!.output_config?.effort, "low");
  });

  it("above the client's level only with REFLEX_EFFORT_UP", async () => {
    const off = await harness({ REFLEX_EFFORT: "1" }, 4).send(newTurn);
    assert.equal(off.rewritten, false, "medium is already in effect");
    assert.deepEqual(off.rec.effort?.reasons, ["effort_up_disabled"]);
    const on = await harness({ REFLEX_EFFORT: "1", REFLEX_EFFORT_UP: "1" }, 4).send(newTurn);
    assert.equal(top(on.sent), "max");
  });

  it("with the setting off nothing changes and nothing is recorded", async () => {
    const a = await harness({}, 0).send(newTurn);
    assert.equal(a.rewritten, false);
    assert.equal(a.rec.effort, undefined);
  });

  it("a rejected effort change is not stored, disables no tier, and stops new levels for the session", async () => {
    const h = harness({ REFLEX_EFFORT: "1" }, 0);
    const a = await h.send(newTurn, 400);
    assert.equal(a.rec.effort?.via, null);
    assert.equal(fs.existsSync(path.join(h.home, "effort.jsonl")), false, "the model never saw it");
    const c = await h.send({ headers: newTurn.headers, body: contBody });
    assert.equal(c.rewritten, false, "nothing to re-insert");
    const b = await h.send(newTurn);
    assert.equal(b.rewritten, false, "no new level after a rejection");
    assert.equal(b.rec.forwarded.model, "claude-opus-5-5");
  });

  it("routed to Sonnet on its first request: the top-level level is set there and kept for the loop", async () => {
    const h = harness({ REFLEX_EFFORT: "1" }, 0, tmp(), "sonnet");
    const a = await h.send(newTurn);
    assert.equal(model(a.sent), "claude-sonnet-5");
    assert.equal(top(a.sent), "low");
    assert.ok(msgs(a.sent).every((m) => m.output_config === undefined), "Sonnet takes no effort message");
    assert.equal(a.rec.effort?.via, "top-level");
    const c = await h.send({ headers: newTurn.headers, body: contBody });
    assert.equal(model(c.sent), "claude-sonnet-5");
    assert.equal(top(c.sent), "low");
  });
});
