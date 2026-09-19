// REFLEX_DELEGATE: which UserPromptSubmit events get the delegation hint, and what the hook answer may contain.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import { HINT_TEXT, HINT_VERSION } from "../../src/delegate/hint.js";
import { hintReply } from "../../src/delegate/reply.js";
import { parseHookEvent, type HookEvent } from "../../src/outcome/hooks.js";
import { isTypedPrompt } from "../../src/wire/claude-code.js";

const prompt = (p: string, agentId: string | null = null): HookEvent => ({ type: "UserPromptSubmit", base: { sessionId: "s", promptId: "p", agentId }, prompt: p });

/** The UserPromptSubmit prompts recorded in the fixtures' hook streams, typed and injected. */
const fixturePrompts = (): string[] =>
  ["interactive.hooks.jsonl", "sonnet-agent-run.hooks.jsonl"].flatMap((f) =>
    fs.readFileSync(path.join("test", "fixtures", "claude-code", "2.1.277", f), "utf8").trim().split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .map((e) => (e["body"] as Record<string, unknown> | undefined) ?? e)
      .filter((e) => e["hook_event_name"] === "UserPromptSubmit")
      .map((e) => String(e["prompt"])));

describe("delegation hint: when", () => {
  it("typed prompts get it, including pasted content", () => {
    assert.ok(isTypedPrompt("fix the parser"));
    assert.ok(isTypedPrompt('\n\n<pasted_content id="ec1f">\nuse a subagent\n</pasted_content id="ec1f">\n'));
    assert.ok(hintReply(prompt("fix the parser")));
  });
  it("never on injected messages, subagent hand-backs, slash commands, blank prompts or subagent events", () => {
    for (const p of [
      "Another Claude session sent a message: hi",
      "[SYSTEM NOTIFICATION - NOT USER INPUT] done",
      "<task-notification>\n<task-id>A</task-id>",
      '<agent-message from="AGENT-1">\n[Subagent hand-back] report',
      "[SUGGESTION MODE: suggest]",
      "/compact",
      "  /model sonnet",
      "",
      "   \n",
    ]) {
      assert.equal(isTypedPrompt(p), false, JSON.stringify(p));
      assert.equal(hintReply(prompt(p)), null, JSON.stringify(p));
    }
    assert.equal(hintReply(prompt("fix the parser", "agent-1")), null, "a subagent's event");
  });
  it("the fixtures' hook streams: typed prompts yes, the hand-back and the task notification no", () => {
    const got = fixturePrompts().map((p) => [p.slice(0, 20), isTypedPrompt(p)] as const);
    assert.ok(got.length >= 4, "fixture prompts found");
    for (const [p, typed] of got) assert.equal(typed, !p.startsWith("<agent-message") && !p.startsWith("<task-notification"), p);
  });
  it("only UserPromptSubmit, and a null or unparsable event gets nothing", () => {
    assert.equal(hintReply(null), null);
    assert.equal(hintReply(parseHookEvent(Buffer.from(JSON.stringify({ session_id: "s", hook_event_name: "Stop" })))), null);
    assert.equal(hintReply(parseHookEvent(Buffer.from("not json"))), null);
  });
});

describe("delegation hint: what", () => {
  it("the answer holds additionalContext only: nothing that could block or rewrite the prompt", () => {
    const body = JSON.parse(hintReply(prompt("fix it"))!.toString()) as Record<string, unknown>;
    assert.deepEqual(body, { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: HINT_TEXT } });
  });
  it("is short (about three lines), fixed and versioned", () => {
    assert.ok(HINT_TEXT.split("\n").length <= 4);
    assert.ok(HINT_TEXT.length < 500);
    assert.match(HINT_VERSION, /^delegate-\d+$/);
  });
  it("the hint text lives in src/delegate/hint.ts only", () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const needle = "Keep this conversation for synthesis";
    assert.deepEqual(walk("src").filter((f) => fs.readFileSync(f, "utf8").includes(needle)), [path.join("src", "delegate", "hint.ts")]);
  });
});

describe("delegation hint: config", () => {
  it("off by default; REFLEX_DELEGATE=1 turns it on; with REFLEX_MODE=off it warns", () => {
    const off = loadConfig({}, "/home/u");
    assert.ok(off.ok && off.config.delegate === false);
    const on = loadConfig({ REFLEX_DELEGATE: "1" }, "/home/u");
    assert.ok(on.ok && on.config.delegate === true && on.warnings.length === 0);
    const plain = loadConfig({ REFLEX_DELEGATE: "1", REFLEX_MODE: "off" }, "/home/u");
    assert.ok(plain.ok);
    assert.match(plain.warnings.join("\n"), /REFLEX_DELEGATE has no effect with REFLEX_MODE=off/);
  });
});
