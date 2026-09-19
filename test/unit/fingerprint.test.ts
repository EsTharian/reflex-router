// Fingerprints of unclassified side calls (src/wire/fingerprint.ts): structure only, and the user's own words never
// land in one. The leak checks look for any 12-character window of the user's text in the serialised fingerprint.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { DecisionLog, type DecisionRecord } from "../../src/log/decision-log.js";
import { buildFingerprints, reportCommand } from "../../src/report/index.js";
import { parseRecords } from "../../src/report/records.js";
import { s11Fingerprints } from "../../src/report/sections.js";
import { FINGERPRINT_HEAD_MAX, sideFingerprint, type SideFingerprint } from "../../src/wire/fingerprint.js";
import { Breaker } from "../../src/worker/breaker.js";
import { Router } from "../../src/worker/router.js";
import { loadFixtures, viewOf } from "../support/fixtures.js";
import { waitFor } from "../support/http.js";
import { dec, toJsonl } from "../support/report-fixtures.js";

type Msg = { role: string; content: unknown };
const bodyOf = (messages: Msg[], extra: Record<string, unknown> = {}): Buffer =>
  Buffer.from(JSON.stringify({ model: "claude-opus-5", max_tokens: 32000, system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.277" }], tools: [{ name: "Bash" }, { name: "Read" }], messages, ...extra }));
const HEADERS = { "anthropic-beta": "prompt-caching-scope-2026-01-05, claude-code-20250219,context-1m-2025-08-07" };
const text = (t: string): { type: string; text: string } => ({ type: "text", text: t });
const fpOf = (messages: Msg[], typed: readonly string[] | null = []): SideFingerprint => {
  const fp = sideFingerprint(HEADERS, bodyOf(messages), typed);
  assert.ok(fp);
  return fp;
};

/**
 * No 12-code-point window of `userText` (whitespace collapsed, case-insensitive) appears in the fingerprint.
 *
 * `betas` is excluded from the haystack: it is a fixed vocabulary copied from the `anthropic-beta` request header, so
 * a window of user text can collide with it by coincidence without anything having leaked (a prompt containing
 * "conversation" matches the beta `mid-conversation-system-…`). That betas really are header-derived, and so can
 * never carry text, is asserted separately by `assertBetasFromHeader`.
 */
function assertNoLeak(fp: SideFingerprint, userText: string, label: string): void {
  const { betas: _betas, ...rest } = fp;
  const hay = JSON.stringify(rest).toLowerCase();
  const cps = Array.from(userText.replace(/\s+/g, " ").trim().toLowerCase());
  for (let i = 0; i + 12 <= cps.length; i++) {
    const w = cps.slice(i, i + 12).join("");
    assert.ok(!hay.includes(w) && !hay.includes(JSON.stringify(w).slice(1, -1)), `${label}: "${w}" leaked into ${hay}`);
  }
}

describe("fingerprint: structure", () => {
  it("counts, roles, block types, parameters and sorted betas; no tool names, no system text", () => {
    const fp = sideFingerprint(HEADERS, bodyOf([{ role: "user", content: [text("[SYSTEM NOTIFICATION - NOT USER INPUT] Task finished")] }, { role: "assistant", content: [text("ok")] }, { role: "system", content: "sys" }, { role: "user", content: "Summarise the conversation so far" }], { thinking: { type: "adaptive" }, output_config: { effort: "high" }, stream: true }), []);
    assert.ok(fp);
    assert.equal(fp.messages, 4);
    assert.equal(fp.roles, "uasu");
    assert.equal(fp.tools, 2);
    assert.equal(fp.tool_result, false);
    assert.deepEqual(fp.system, { prompt: "blocks", prompt_blocks: 1, messages: 1 });
    assert.deepEqual(fp.last, { role: "user", content: "string", blocks: [], text_chars: 33 });
    assert.equal(fp.max_tokens, 32000);
    assert.equal(fp.thinking, "adaptive");
    assert.equal(fp.effort, "high");
    assert.equal(fp.stream, true);
    assert.deepEqual(fp.betas, ["claude-code-20250219", "context-1m-2025-08-07", "prompt-caching-scope-2026-01-05"]);
    assert.equal(fp.head, "Summarise the conversation so far");
    const s = JSON.stringify(fp);
    assert.doesNotMatch(s, /Bash|Read|billing|cc_version/);
  });
  it("a long role sequence keeps its first 8 and last 30 letters", () => {
    const msgs: Msg[] = Array.from({ length: 101 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: [text("x")] }));
    const fp = fpOf(msgs);
    assert.equal(fp.messages, 101);
    assert.equal(fp.roles, `uauauaua..${"au".repeat(15)}`);
  });
  it("tool results anywhere, and the last message's block types", () => {
    const fp = fpOf([{ role: "user", content: [text("Go")] }, { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "out" }, text("[Harness note] keep going")] }]);
    assert.equal(fp.tool_result, true);
    assert.deepEqual(fp.last.blocks, ["tool_result", "text"]);
    assert.equal(fp.head, "[Harness note] keep going");
  });
  it("harness text is redacted and capped", () => {
    const fp = fpOf([{ role: "user", content: [text(`[SYSTEM NOTIFICATION] key sk-ant-abcdefghijklmnop123 ${"A".repeat(200)}`)] }]);
    assert.ok(fp.head);
    assert.match(fp.head, /^\[SYSTEM NOTIFICATION\] key \[REDACTED:anthropic_key\]/);
    assert.equal(Array.from(fp.head).length, FINGERPRINT_HEAD_MAX);
    assert.doesNotMatch(JSON.stringify(fp), /abcdefghijklmnop/);
  });
  it("not JSON or not an object: null", () => {
    assert.equal(sideFingerprint({}, Buffer.from("nope"), []), null);
    assert.equal(sideFingerprint({}, Buffer.from("[1]"), []), null);
  });
});

describe("fingerprint: user text never lands in one", () => {
  const cases: { label: string; messages: Msg[]; typed: readonly string[] | null; user: string; why: string }[] = [
    { label: "lowercase start", messages: [{ role: "user", content: [text("please refactor the billing module so it streams")] }], typed: [], user: "please refactor the billing module so it streams", why: "not_template_start" },
    { label: "another language", messages: [{ role: "user", content: [text("Bu dosyayı düzelt ve testleri çalıştır lütfen")] }], typed: [], user: "Bu dosyayı düzelt ve testleri çalıştır lütfen", why: "non_ascii" },
    { label: "first person", messages: [{ role: "user", content: [text("Now I want the parser to stream its output")] }], typed: [], user: "Now I want the parser to stream its output", why: "first_person" },
    { label: "a path", messages: [{ role: "user", content: [text("Refactor src/report/sections.ts to stream output")] }], typed: [], user: "Refactor src/report/sections.ts to stream output", why: "path_or_url" },
    { label: "a file name", messages: [{ role: "user", content: [text("Refactor parser.ts to stream the whole output")] }], typed: [], user: "Refactor parser.ts to stream the whole output", why: "path_or_url" },
    { label: "a URL", messages: [{ role: "user", content: [text("Check https://internal.example.com/dashboards now")] }], typed: [], user: "Check https://internal.example.com/dashboards now", why: "path_or_url" },
    { label: "an e-mail address", messages: [{ role: "user", content: [text("Send the summary to someone@example.com today")] }], typed: [], user: "Send the summary to someone@example.com today", why: "path_or_url" },
    { label: "a typed prompt that looks like a template", messages: [{ role: "user", content: [text("Refactor the billing module to stream its output")] }], typed: ["Refactor the billing module to stream its output"], user: "Refactor the billing module to stream its output", why: "typed_prompt" },
    { label: "a typed prompt behind a harness prefix", messages: [{ role: "user", content: [text("[Queued] Rename the helper everywhere and rerun")] }], typed: ["Rename the helper everywhere and rerun"], user: "Rename the helper everywhere and rerun", why: "typed_prompt" },
    { label: "a long typed prompt, its start only in the call", messages: [{ role: "user", content: [text("Rename the helper everywhere and rerun the whole suite, then update the changelog and the docs accordingly")] }], typed: ["Rename the helper everywhere and rerun the whole suite, then update the changelog and the docs accordingly, and tag it"], user: "Rename the helper everywhere and rerun the whole suite", why: "typed_prompt" },
    { label: "typed text next to tool results", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }, text("Also rename the helper module afterwards")] }], typed: ["Also rename the helper module afterwards"], user: "Also rename the helper module afterwards", why: "typed_prompt" },
    { label: "pasted content", messages: [{ role: "user", content: [text('<pasted_content id="a1b2">\nCONFIDENTIAL QUARTERLY NUMBERS 42\n</pasted_content id="a1b2">')] }], typed: [], user: "CONFIDENTIAL QUARTERLY NUMBERS 42", why: "user_wrapper" },
    { label: "a local command", messages: [{ role: "user", content: [text("<command-name>/deploy</command-name><command-args>Production Cluster Seven</command-args>")] }], typed: [], user: "Production Cluster Seven", why: "user_wrapper" },
    { label: "an image with text", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, text("Fix This Layout Bug On The Settings Page")] }], typed: [], user: "Fix This Layout Bug On The Settings Page", why: "attachment" },
    { label: "no prompt hooks in the session", messages: [{ role: "user", content: [text("Refactor the billing module to stream its output")] }], typed: null, user: "Refactor the billing module to stream its output", why: "no_prompt_hooks" },
    { label: "an assistant message last", messages: [{ role: "user", content: [text("Go")] }, { role: "assistant", content: [text("Here Is What The Model Said About Your Code")] }], typed: [], user: "Here Is What The Model Said About Your Code", why: "not_user_message" },
    { label: "blank text", messages: [{ role: "user", content: [text("   ")] }], typed: [], user: "", why: "no_text" },
  ];
  for (const c of cases) {
    it(`${c.label}: omitted (${c.why})`, () => {
      const fp = fpOf(c.messages, c.typed);
      assert.equal(fp.head, null);
      assert.equal(fp.head_omitted, c.why);
      assertNoLeak(fp, c.user, c.label);
    });
  }

  it("a reminder quoting the user: only its preamble is kept", () => {
    const fp = fpOf([{ role: "user", content: [text("<system-reminder>\nThe user sent the following message:\nFix the flaky login tests before lunch\n</system-reminder>")] }]);
    assert.equal(fp.head, "The user sent the following message:");
    assertNoLeak(fp, "Fix the flaky login tests before lunch", "reminder");
  });
  it("text after the first line or colon is never kept", () => {
    const fp = fpOf([{ role: "user", content: "[Queued message] Deploy Cluster Seven Tonight\nSecond Line Of Private Details" }]);
    assert.equal(fp.head, "[Queued message] Deploy Cluster Seven Tonight");
    assertNoLeak(fp, "Second Line Of Private Details", "second line");
    const colon = fpOf([{ role: "user", content: "Summary requested: Quarterly Revenue Draft For Board" }]);
    assert.equal(colon.head, "Summary requested:");
    assertNoLeak(colon, "Quarterly Revenue Draft For Board", "after colon");
  });

  it("every fixture's betas come from the anthropic-beta header, never from the body", () => {
    for (const fx of loadFixtures()) {
      const raw = fx.headers["anthropic-beta"];
      const sent = new Set(String(Array.isArray(raw) ? raw.join(",") : (raw ?? "")).split(",").map((x) => x.trim()).filter(Boolean));
      for (const b of sideFingerprint(fx.headers, fx.body, [])?.betas ?? []) assert.ok(sent.has(b), `${fx.file}: beta ${b} is not in the request header`);
    }
  });

  it("every recorded request fixture: the user's own text never lands, whatever the classification", () => {
    for (const fx of loadFixtures()) {
      const v = viewOf(fx);
      const task = v.task ?? v.previousAssistantText;
      for (const typed of [null, [], ...(v.task ? [[v.task]] : [])]) {
        const fp = sideFingerprint(fx.headers, fx.body, typed);
        assert.ok(fp, fx.file);
        if (v.turn === "new" && v.kind === "main" && typed !== null && typed.length > 0) assert.equal(fp.head, null, `${fx.file}: a typed prompt must be omitted`);
        if (task && typed !== null && typed.length > 0) assertNoLeak(fp, task, fx.file);
        if (typed === null) assert.equal(fp.head, null, `${fx.file}: without prompt hooks nothing is kept`);
      }
    }
  });

  it("harness side-call fixtures keep their harness text (hooks seen, no typed match)", () => {
    const heads = Object.fromEntries(loadFixtures().filter((f) => f.expect.turn === "side").map((f) => [f.file, sideFingerprint(f.headers, f.body, [])?.head ?? null]));
    assert.equal(heads["interactive.main-notification.request.json"], "[SYSTEM NOTIFICATION - NOT USER INPUT]");
    assert.equal(heads["interactive.main-suggestion.request.json"], "[SUGGESTION MODE:");
    for (const h of Object.values(heads)) if (h !== null) assert.ok(Array.from(h).length <= FINGERPRINT_HEAD_MAX);
  });
});

describe("fingerprint: router and report", () => {
  it("the router attaches a fingerprint to unclassified side calls only, using the session's typed prompts", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "reflex-fp-"));
    const loaded = loadConfig({ REFLEX_MODE: "shadow", REFLEX_HOME: home });
    assert.ok(loaded.ok);
    const log = new DecisionLog(home, false);
    const typed = new Map<string, string[]>([["s-1", ["Refactor the billing module to stream its output"]]]);
    const router = new Router({ config: loaded.config, effectiveMode: "shadow", degradedReason: null, claudeVersion: "2.1.277", backend: null, breaker: new Breaker(), log, logger: () => undefined, typedPrompts: (sid) => (sid === null ? null : (typed.get(sid) ?? null)) });
    const headers = { ...HEADERS, "x-claude-code-session-id": "s-1" };
    const send = async (messages: Msg[]): Promise<void> => {
      const p = await router.prepare("POST", "/v1/messages", headers, bodyOf(messages));
      assert.ok(p.obs);
      p.obs.headers(200, { "content-type": "application/json" });
      p.obs.finish(true);
    };
    await send([{ role: "user", content: "Refactor the billing module to stream its output" }]); // plain string: unclassified
    await send([{ role: "user", content: "[Harness] Summarise the last action" }]);
    await send([{ role: "user", content: [text("Refactor the billing module")] }]); // a new turn: no fingerprint
    const recs = await waitFor(() => {
      const lines = fs.existsSync(log.file) ? fs.readFileSync(log.file, "utf8").trim().split("\n").filter(Boolean) : [];
      return lines.length === 3 ? lines.map((l) => JSON.parse(l) as DecisionRecord) : null;
    });
    const un = recs.filter((r) => r.side_kind === "unclassified");
    assert.equal(un.length, 2);
    const byHead = un.map((r) => [r.side_fingerprint?.head ?? null, r.side_fingerprint?.head_omitted ?? null]);
    assert.deepEqual(byHead.sort(), [["[Harness] Summarise the last action", null], [null, "typed_prompt"]].sort());
    assert.ok(recs.filter((r) => r.side_kind !== "unclassified").every((r) => !("side_fingerprint" in r)));
    assert.doesNotMatch(fs.readFileSync(log.file, "utf8"), /billing module to stream/);
  });

  it("section 11 groups fingerprints by everything but length; --fingerprints prints JSON lines only", () => {
    const fp = (messages: number, head: string | null): Record<string, unknown> => ({ v: 1, messages, roles: "u".repeat(messages), tools: 3, tool_result: false, system: { prompt: "blocks", prompt_blocks: 2, messages: 0 }, last: { role: "user", content: "string", blocks: [], text_chars: messages * 10 }, max_tokens: 1024, thinking: null, effort: null, stream: true, betas: ["b"], head, head_omitted: head === null ? "typed_prompt" : null });
    const recs = [
      { ...dec({ id: "u1", t: 0, turn: "side", side: "unclassified", usage: [0, 0, 0, 100] }), side_fingerprint: fp(3, "[X] a") },
      { ...dec({ id: "u2", t: 1, turn: "side", side: "unclassified", usage: [0, 0, 0, 200] }), side_fingerprint: fp(9, "[X] a") },
      { ...dec({ id: "u3", t: 2, turn: "side", side: "unclassified", usage: [0, 0, 0, 5] }), side_fingerprint: fp(2, null) },
      dec({ id: "u4", t: 3, turn: "side", side: "unclassified", usage: [0, 0, 0, 1] }),
    ];
    const rec = parseRecords([{ source: "t", text: toJsonl(recs) }]);
    const out = s11Fingerprints({ rec, byId: new Map(), usd: false }).join("\n");
    assert.match(out, /4 unclassified side calls, 306 tokens; 2 distinct fingerprints; 1 without one/);
    assert.match(out, /n=2, 300 tokens, kind main, claude 2\.1\.277, messages 3-9: .*"head":"\[X\] a"/);
    const lines = buildFingerprints(rec, {}).trim().split("\n").map((l) => JSON.parse(l) as { n: number; message_count: { min: number; max: number } });
    assert.deepEqual(lines.map((l) => [l.n, l.message_count.min, l.message_count.max]), [[2, 3, 9], [1, 2, 2]]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reflex-fp-report-"));
    fs.writeFileSync(path.join(dir, "d.jsonl"), toJsonl(recs));
    let stdout = "";
    assert.equal(reportCommand(["--fingerprints", path.join(dir, "d.jsonl")], { env: {}, stdout: (t) => (stdout += t), stderr: () => undefined }), 0);
    assert.equal(stdout.trim().split("\n").length, 2);
    assert.ok(stdout.split("\n").filter(Boolean).every((l) => l.startsWith("{")));
  });
});
