// The 2.1.278 regression, pinned in both directions.
//
// 2.1.277 sent every user-typed prompt as an array of blocks and only harness side calls as plain strings, so the
// classifier read a plain-string content as proof of a side call. 2.1.278 sends typed prompts as plain strings too.
// A whole 13-turn session then classified one `new` turn and ten `side` / `unclassified` ones: nothing was decided
// after the first prompt, the pin never moved, and every request still forwarded correctly -- so nothing failed
// loudly. These tests are the regression's shape, replayed.
//
// The rule now: a plain string is the user's turn only when the hook stream says those words were typed. No hooks,
// no claim -- which is the fail-safe direction, because an unrecognised request forwards unchanged.
import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { describe, it } from "node:test";
import { parseRequest, type RequestView } from "../../src/wire/claude-code.js";
import { DRIFT_MIN_TYPED_PROMPTS, DriftTracker } from "../../src/wire/drift.js";
import { loadFixtures } from "../support/fixtures.js";

const SID = "5e551011-0000-4000-8000-0000000002ab";
const H: IncomingHttpHeaders = { "x-claude-code-session-id": SID, "anthropic-beta": "mid-conversation-system-2026-04-07,extended-cache-ttl-2025-04-11", "user-agent": "claude-cli/2.1.278 (external, cli)" };
const SYSTEM = [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.278.abc; cc_entrypoint=cli;" }];
const TOOLS = [{ name: "Bash" }, { name: "Read" }];
const text = (t: string): unknown => ({ type: "text", text: t });

const body = (messages: unknown[]): Buffer =>
  Buffer.from(JSON.stringify({ model: "claude-sonnet-5", system: SYSTEM, tools: TOOLS, messages, metadata: { user_id: JSON.stringify({ session_id: SID }) } }));

/**
 * `typed` null: no UserPromptSubmit has been delivered for the session. `newest` defaults to the last of `typed` --
 * the newest prompt, unclaimed -- which is the state a request arrives in right after its own hook fired.
 */
const view = (messages: unknown[], typed: readonly string[] | null, newest?: string | null): RequestView => {
  const n = newest === undefined ? (typed === null ? null : (typed.at(-1) ?? null)) : newest;
  const r = parseRequest(H, body(messages), () => typed, () => n);
  assert.ok(r.ok);
  return r.view;
};

describe("2.1.278 plain-string typed prompts", () => {
  const PROMPT = "Read src/pricing.ts and list every exported constant with its line number.";
  const plain = [{ role: "user", content: PROMPT }];

  it("a plain string the hook stream vouches for is the user's new turn", () => {
    const v = view(plain, [PROMPT]);
    assert.equal(v.turn, "new");
    assert.equal(v.sideKind, null);
    assert.equal(v.unclassifiedReason, null);
    assert.equal(v.task, PROMPT);
  });

  it("the same bytes with no hook stream stay side, and say which test sent them there", () => {
    const v = view(plain, null);
    assert.equal(v.turn, "side");
    assert.equal(v.sideKind, "unclassified");
    assert.equal(v.unclassifiedReason, "plain_string_no_typed_match");
    assert.equal(v.task, null);
  });

  it("a plain string no typed prompt matches stays side: harness text is not promoted", () => {
    const v = view([{ role: "user", content: "[Harness] Describe your most recent action in 5 words." }], [PROMPT]);
    assert.equal(v.turn, "side");
    // The marker table still runs first, so a *named* harness side call keeps its own kind rather than the residual.
    assert.equal(v.sideKind, "agent_summary");
    assert.equal(v.unclassifiedReason, null);
  });

  it("a marked plain-string side call is named by its marker, not by the hook stream", () => {
    const v = view([{ role: "user", content: "[SUGGESTION MODE: propose three follow-ups]" }], [PROMPT]);
    assert.deepEqual([v.turn, v.sideKind, v.sideMarker], ["side", "suggestion", "suggestion"]);
  });

  it("each residual says which shape test produced it, so section 11 can read them apart", () => {
    assert.equal(view([{ role: "assistant", content: [text("done")] }], [PROMPT]).unclassifiedReason, "not_user_message");
    assert.equal(view([{ role: "user", content: [{ type: "image", source: {} }] }], [PROMPT]).unclassifiedReason, "non_text_block");
    assert.equal(view([{ role: "user", content: [text("   ")] }], [PROMPT]).unclassifiedReason, "no_own_text");
  });

  it("the derived 2.1.278 fixture classifies new once its own hook prompt is in the stream", () => {
    const fx = loadFixtures().find((f) => f.file === "ultracode.main-new-turn-plain-string.request.json");
    assert.ok(fx, "the plain-string fixture is loaded");
    const without = parseRequest(fx.headers, fx.body);
    assert.ok(without.ok);
    assert.deepEqual([without.view.turn, without.view.unclassifiedReason], ["side", "plain_string_no_typed_match"]);

    // The prompt the capture's own hooks.jsonl delivered for this request.
    const hookPrompt = "ultracode: review src/wire/ and src/outcome/ for places where the Claude Code version is treated as more than a hint, rather than verified at runtime. Read and search only. Report concrete findings with file:line.";
    const with_ = parseRequest(fx.headers, fx.body, () => [hookPrompt], () => hookPrompt);
    assert.ok(with_.ok);
    assert.equal(with_.view.turn, "new");
    assert.equal(with_.view.unclassifiedReason, null);
  });
});

describe("2.1.278 session replay: the 13-turn session that routed nothing", () => {
  // The observed session: an opening prompt delivered as blocks, then typed prompts as plain strings, each followed by
  // a tool loop. Eleven prompts in total; before the fix exactly one of them classified as `new`.
  const PROMPTS = Array.from({ length: 11 }, (_, i) => `Turn ${String(i + 1)}: summarise what changed in src/report/ and why it matters.`);

  /** The request Claude Code sends for prompt `i`: the whole history, then the new prompt as the last user message. */
  const requestFor = (i: number): unknown[] => {
    const history: unknown[] = [{ role: "user", content: [text(PROMPTS[0]!)] }];
    for (let k = 1; k <= i; k++) {
      history.push({ role: "assistant", content: [{ type: "tool_use", id: `t${String(k)}`, name: "Read", input: {} }] });
      history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${String(k)}`, content: "ok" }] });
      history.push({ role: "assistant", content: [text("Done.")] });
      history.push({ role: "user", content: PROMPTS[k]! }); // 2.1.278: a plain string
    }
    return history;
  };

  it("without the hook stream the whole session collapses to one new turn (the regression)", () => {
    const turns = PROMPTS.map((_, i) => view(requestFor(i), null).turn);
    assert.equal(turns.filter((t) => t === "new").length, 1, "only the opening block-array prompt is recognised");
    assert.equal(turns.filter((t) => t === "side").length, 10);
  });

  it("with the hook stream every one of the 11 typed prompts is a new turn", () => {
    // Prompt i is the newest one when its own request arrives, and nothing has claimed it yet.
    const views = PROMPTS.map((_, i) => view(requestFor(i), PROMPTS, PROMPTS[i]));
    assert.equal(views.filter((v) => v.turn === "new").length, 11, views.map((v) => `${v.turn}/${v.sideKind ?? "-"}`).join(","));
    assert.ok(views.every((v) => v.sideKind === null && v.unclassifiedReason === null));
    assert.ok(views.every((v) => v.task !== null && v.task.startsWith("Turn ")));
  });

  it("a plain string carrying an OLDER prompt is a history replay, not a new turn", () => {
    // The shape a side call wears when it replays the conversation up to some earlier user message. Its text is a real
    // prompt the user really typed, so the whole-list match would promote it; only the newest-unclaimed test refuses.
    const replay = [
      { role: "user", content: [text(PROMPTS[0]!)] },
      { role: "assistant", content: [text("Done.")] },
      { role: "user", content: PROMPTS[3]! }, // an older prompt, re-encoded as a string in history
    ];
    const v = view(replay, PROMPTS, PROMPTS[9]); // the newest unclaimed prompt is a different, later one
    assert.equal(v.turn, "side");
    assert.equal(v.unclassifiedReason, "plain_string_no_typed_match");
  });

  it("once a turn has claimed the newest prompt, a repeat of the same request is no longer new", () => {
    const req = [{ role: "user", content: [text(PROMPTS[0]!)] }, { role: "assistant", content: [text("Done.")] }, { role: "user", content: PROMPTS[1]! }];
    assert.equal(view(req, PROMPTS, PROMPTS[1]).turn, "new", "first time: the prompt is unclaimed");
    assert.equal(view(req, PROMPTS, null).turn, "side", "claimed: nothing left to promote it");
  });

  it("a tool_result carrying a typed prompt is still an interjection, not a new turn", () => {
    // The shape the original hypothesis described. It is a real shape and it must keep its own answer: the tool loop
    // has not ended, so the turn is the user's existing one and must not be decided again.
    const mid = [
      { role: "user", content: [text(PROMPTS[0]!)] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }, text(PROMPTS[1]!)] },
    ];
    const v = view(mid, PROMPTS, PROMPTS[1]);
    assert.equal(v.turn, "continuation");
    assert.equal(v.interjection, true);
  });
});

describe("wire drift cross-check", () => {
  const mainNew = { kind: "main", turn: "new" } as unknown as RequestView;
  const mainSide = { kind: "main", turn: "side" } as unknown as RequestView;
  /** A request whose model and max_tokens the fixtures hold, so only the typed-prompt check can fire. */
  const known = { requestedModel: "claude-sonnet-5", facts: { maxTokens: 64000 } } as unknown as RequestView;

  it("fires once when typed prompts pile up behind a session that found no new turns", () => {
    const d = new DriftTracker();
    d.observe(mainNew); // the opening turn, the only one recognised
    for (let i = 0; i < 9; i++) d.observe(mainSide);
    assert.deepEqual(d.check(DRIFT_MIN_TYPED_PROMPTS - 1, known), [], "below the threshold a quiet session is not drift");
    assert.deepEqual(d.check(10, known), ["typed_prompts_without_new_turns"]);
    assert.deepEqual(d.check(10, known), [], "reported once per session");
  });

  it("stays silent on a healthy session, however many prompts it has", () => {
    const d = new DriftTracker();
    for (let i = 0; i < 12; i++) d.observe(mainNew);
    assert.deepEqual(d.check(12, known), []);
  });

  it("a subagent's first request is not the user typing", () => {
    const d = new DriftTracker();
    d.observe(mainNew);
    for (let i = 0; i < 5; i++) d.observe({ kind: "subagent", turn: "new" } as unknown as RequestView);
    assert.equal(d.newTurns, 1);
    assert.deepEqual(d.check(5, known), ["typed_prompts_without_new_turns"]);
  });

  it("flags a requested model and a max_tokens no fixture holds, once per distinct value per session", () => {
    const d = new DriftTracker();
    const opus55 = { requestedModel: "claude-opus-5-5", facts: { maxTokens: 128000 } } as unknown as RequestView;
    assert.deepEqual(d.check(0, opus55), ["unseen_requested_model", "unseen_max_tokens"]);
    assert.deepEqual(d.check(0, opus55), []);
    assert.deepEqual(d.check(0, { requestedModel: "claude-opus-5-5", facts: { maxTokens: 96000 } } as unknown as RequestView), ["unseen_max_tokens"]);
    assert.deepEqual(d.check(0, known), []);
  });
});

describe("2.1.280: a main new turn needs a typed prompt once hooks are arriving (no_typed_prompt)", () => {
  // Session 999c1b7f: four array-encoded main-chat calls within 50 s, none behind a UserPromptSubmit, each decided and
  // routed as a new turn. Array encoding is what 2.1.277 used for typed prompts, so the shape alone cannot tell them apart.
  const PROMPT = "Refactor the parser so the tokenizer is its own module.";
  const array = (t: string): unknown[] => [{ role: "user", content: [text(t)] }];

  it("hooks arriving, the newest prompt already claimed: the harness call is side / unclassified", () => {
    const v = view(array("Summarise the conversation so far for the session title."), [PROMPT], null);
    assert.deepEqual([v.turn, v.sideKind, v.unclassifiedReason, v.task], ["side", "unclassified", "no_typed_prompt", null]);
  });

  it("hooks arriving, a newest prompt that is not these words: still side", () => {
    const v = view(array("Summarise the conversation so far for the session title."), [PROMPT]);
    assert.equal(v.unclassifiedReason, "no_typed_prompt");
  });

  it("the prompt the user just typed is a new turn, as before", () => {
    const v = view(array(PROMPT), [PROMPT]);
    assert.deepEqual([v.turn, v.task], ["new", PROMPT]);
  });

  it("no hook stream: the structural rule stands alone (tests, spikes, a session whose hooks never arrived)", () => {
    assert.equal(view(array("Summarise the conversation so far."), null).turn, "new");
  });
});
