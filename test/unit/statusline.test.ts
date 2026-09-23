import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchStatus, formatStatus, shortModel } from "../../src/statusline.js";
import { parseStatusInput } from "../../src/wire/statusline.js";
import { SessionStatus } from "../../src/worker/session-status.js";
import { hasOwnStatusLine, mergeSettings } from "../../src/launcher/settings-inject.js";
import type { DecisionInfo } from "../../src/outcome/tracker.js";
import type { DecisionRecord } from "../../src/log/decision-log.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g");
const plain = (s: string | null): string | null => (s === null ? null : s.replace(ANSI, ""));
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5";
const HAIKU = "claude-haiku-4-5-20251001";

describe("statusline", () => {
  it("short model names", () => {
    assert.equal(shortModel("claude-opus-5-5[1m]"), "Opus 5.5");
    assert.equal(shortModel(HAIKU), "Haiku 4.5");
    assert.equal(shortModel(SONNET), "Sonnet 5");
    assert.equal(shortModel("claude-fable-5-1"), "Fable 5.1");
    assert.equal(shortModel("some-gateway-model"), "some-gateway-model");
  });

  it("shows the model reflex sent when it differs from the one asked for, and routed subagents", () => {
    assert.equal(plain(formatStatus({ worker: "up", main: { requested: OPUS, sent: SONNET }, subagents: [] })), "⇣ Sonnet 5 (asked Opus 5.5)");
    assert.equal(plain(formatStatus({ worker: "up", main: { requested: SONNET, sent: OPUS }, subagents: [] })), "⇡ Opus 5.5 (asked Sonnet 5)");
    const subs = [{ requested: OPUS, sent: HAIKU }, { requested: OPUS, sent: HAIKU }, { requested: OPUS, sent: OPUS }];
    assert.equal(plain(formatStatus({ worker: "up", main: { requested: OPUS, sent: OPUS }, subagents: subs })), "reflex: Opus 5.5 · subagents → Haiku 4.5 ×2");
    assert.equal(plain(formatStatus({ worker: "up", main: null, subagents: [] })), "reflex");
    const main = { requested: OPUS, sent: OPUS };
    assert.equal(plain(formatStatus({ worker: "up", main, subagents: [], saved: { session: 0.4231, total: 3.1 } })), "reflex: Opus 5.5 · est. saved $0.42 (total $3.10)");
    assert.equal(plain(formatStatus({ worker: "up", main, subagents: [], saved: { session: 0, total: -0.95 } })), "reflex: Opus 5.5 · est. saved $0.00 (total −$0.95)");
    assert.equal(plain(formatStatus({ worker: "up", main, subagents: [], saved: { session: 0.001, total: null } })), "reflex: Opus 5.5");
    assert.equal(plain(formatStatus({ worker: "up", main: null, subagents: [], saved: { session: 0, total: 2.14 } })), "reflex · est. saved $0.00 (total $2.14)");
    assert.equal(plain(formatStatus({ worker: "down" })), "reflex: passthrough");
    assert.equal(formatStatus(null), null);
  });

  it("reads only session_id and model.display_name from stdin; junk gives nulls", () => {
    assert.deepEqual(parseStatusInput('{"session_id":"s1","model":{"id":"claude-opus-5-5[1m]","display_name":"Opus 5.5 (1M context)"},"cost":{}}'), { sessionId: "s1", displayName: "Opus 5.5 (1M context)" });
    assert.deepEqual(parseStatusInput("not json"), { sessionId: null, displayName: null });
    assert.deepEqual(parseStatusInput("[1]"), { sessionId: null, displayName: null });
  });

  it("only asks a loopback base URL", async () => {
    assert.equal(await fetchStatus("https://api.anthropic.com", "s1"), null);
    assert.equal(await fetchStatus(undefined, "s1"), null);
    assert.equal(await fetchStatus("http://127.0.0.1:9", "s1", 200), null); // nothing listening
  });

  it("the worker keeps the last main-chat and per-subagent pair; side calls are ignored", () => {
    const s = new SessionStatus();
    const d = (o: Partial<DecisionInfo>): DecisionInfo => ({ id: "x", at: 0, sessionId: "s1", agentId: null, kind: "main", turn: "new", conv: null, requestedModel: OPUS, sentModel: OPUS, ...o });
    s.observe(d({ sentModel: SONNET }));
    s.observe(d({ turn: "side", sentModel: HAIKU }));
    s.observe(d({ kind: "subagent", agentId: "a1", sentModel: HAIKU }));
    s.observe(d({ kind: "subagent", agentId: "a1", turn: "continuation", sentModel: HAIKU }));
    assert.deepEqual(s.get("s1"), { main: { requested: OPUS, sent: SONNET }, subagents: [{ requested: OPUS, sent: HAIKU }], saved: { session: 0, total: null } });
    assert.deepEqual(s.get("other"), { main: null, subagents: [], saved: { session: 0, total: null } });
  });

  it("the saving is section 8's: the same usage at the requested model minus at the model sent, routed records only", () => {
    const s = new SessionStatus();
    const rec = (o: Record<string, unknown>) => ({ id: "r", at: "2026-09-23T10:00:00.000Z", turn: "new", requested: { model: OPUS, tier: "opus" }, usage: { input: 1_000_000, output: 0, cache_read: 0, cache_create: 0 }, ...o }) as unknown as DecisionRecord;
    s.addRecord(rec({ forwarded: { model: SONNET, rewritten: true, fallback: false } }), "s1"); // $4 at Opus 5.5, $2 at Sonnet
    s.addRecord(rec({ forwarded: { model: OPUS, rewritten: false, fallback: false } }), "s1"); // not routed: nothing
    s.addRecord(rec({ turn: "side", forwarded: { model: HAIKU, rewritten: true, fallback: false } }), "s1"); // side calls: section 9
    s.addRecord(rec({ forwarded: { model: HAIKU, rewritten: true, fallback: false } }), "s2"); // another session
    s.setLoggedTotal(10);
    assert.deepEqual(s.get("s1").saved, { session: 2, total: 10 + 2 + 3 });
  });

  it("never replaces the user's own status line", () => {
    const ours = { type: "command", command: "reflex statusline" };
    assert.deepEqual(mergeSettings(null, { env: {}, statusLine: ours })["statusLine"], ours);
    const theirs = { type: "command", command: "my-line" };
    assert.deepEqual(mergeSettings({ statusLine: theirs }, { env: {}, statusLine: ours })["statusLine"], theirs);
    const files: Record<string, string> = { a: '{"model":"opus"}', b: '{"statusLine":{"type":"command","command":"x"}}', c: "{broken" };
    const read = (f: string): string => { const t = files[f]; if (t === undefined) throw new Error("ENOENT"); return t; };
    assert.equal(hasOwnStatusLine(["a", "c", "missing"], read), false);
    assert.equal(hasOwnStatusLine(["a", "b"], read), true);
  });
});
