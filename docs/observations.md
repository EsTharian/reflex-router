# Observations

Measured results from running reflex on real sessions (shadow and route mode). Each entry states its conditions and sample size. These are observations, not general claims: one session is not a benchmark.

## 2026-09-19 — first dogfood session

**Setup.** One interactive Claude Code 2.1.277 session (Opus 5 requested on every decided turn), reflex at commit `0e2f76a` (the M2 build), shadow mode, Jev `jev-latest`, run from Turkey. Jev client at that time used global `fetch` (no persistent connection; see Latency).

**Classification.** 61 records: 12 `new` (11 main chat, 1 subagent), 24 `continuation`, 25 `side` (`no_tools` 13, `suggestion` 8, `agent_summary` 1, `compaction` 1, `cross_session` 1, `notification` 1). Zero `unclassified`, zero shape degrades, zero backend errors. `/compact` was classified as `side`/`compaction`.

**Reasoning, not length.** One main-chat turn was a hard question that ended with "answer in one sentence", i.e. it asked for a very short reply. Jev picked `opus` for it with `reasoning_demand` 3.24 (of 0–4). The tier question tells the backend to judge the reasoning a task demands and not the length of the message or reply (`src/policy.ts`), so this is our own first confirmation, on one prompt, of the "reasoning not length" behaviour previously reported for jev-router. The planned labelled comparison (length-framed vs reasoning-framed instructions) is still needed before this is more than one data point.

**Confidence.** 5 of 12 decisions stopped at `low_confidence` (choice confidence below the provisional 0.70 floor), including the only subagent turn (`sonnet`, confidence 0.32). Confidence is a spread statistic over the whole distribution, not the top probability, so a clear top option can still come with low confidence. Thresholds are unchanged; this is input for Phase 2 calibration.

**Decision rule (follow-up, same data).** All five low-confidence decisions were torn between `sonnet` and `haiku` while giving `opus` 0–0.09 (e.g. the subagent turn: sonnet 0.55 / haiku 0.45 / opus 0.00, confidence 0.32). With every request asking for Opus, the argmax-plus-confidence rule kept all five on Opus, the one tier the backend was most sure was not needed. The tier question is ordered, so the default rule is now `mass`: the cheapest tier leaving at most `REFLEX_MASS_EPS` (0.10) probability on the tiers above it. On these twelve vectors it picks `sonnet` for all five low-confidence turns (three were argmax `sonnet`; two were argmax `haiku` at 0.73 and 0.62 and move up to `sonnet` because sonnet held 0.27 and 0.29) and leaves the confident picks unchanged (haiku 1.0 ×2, haiku 0.95, opus 0.76). The vectors are unit tests (`test/unit/policy.test.ts`). `argmax` remains selectable, and every record now logs both picks so later sessions can compare them.

**Latency.** Jev decision latency p50 823 ms, p95 1136 ms (n = 12), measured with a fresh TCP+TLS connection per decision (global `fetch` drops idle connections after about 4 s). Shadow mode keeps this off the critical path. The client now holds a keep-alive connection and records `decision.connection` (`new`/`reused`) so the effect can be measured on the next session.

## 2026-09-19 — route-mode acceptance, sessions A and B: the cache cost model

**Setup.** Interactive Claude Code 2.1.277 sessions, Opus 5 requested, reflex in `route` mode (M3 build), from Turkey. Figures are the `usage` of individual responses in `decisions.jsonl`.

**Observation.** Claude Code's harness side calls (prompt suggestions, other `side` requests) are never rewritten, so they go to the **requested** model, and they carry the same conversation history with the same cache breakpoints. They keep the requested model's prompt cache warm even while the conversation itself is routed elsewhere. Session B:

| Time | Request | Sent to | Cache read | Cache write |
| --- | --- | --- | --- | --- |
| B1 | new turn, routed down (guard: fresh) | Sonnet | 0 | 63,689 |
| B1 | continuation (pinned) | Sonnet | 63,689 | 7,557 |
| B1 | side call (`unclassified`) | Opus | 61,062 | 10,175 |
| B1 | side call (`suggestion`) | Opus | 71,237 | 1,815 |
| B2 | new turn, back on Opus (pre-fix behaviour) | Opus | 73,052 | 52 |

**Cost model that follows.** Moving a conversation **down** costs one cache write of the whole context on the target (B1: 63,689 tokens on Sonnet). Moving it back **up** to the requested model is close to free: its cache is already warm from the side calls (B2: 52 tokens written). The guard's penalty formula (write on the target minus read on the current holder) is the right shape for downward moves; upward moves are not guarded at all. Staying down costs the harness nothing extra, but every side call still bills the requested model, so part of a routed session's spend is on the requested model by construction.

**Consequence for reporting.** Savings estimates must not attribute side-call usage to the routed model: the report shows side-call token usage on the requested model as its own line.

**Follow-up (session B rerun): "one tier up" can cost more than "back to requested".** B1 was routed to Haiku (override), B2 moved up to Sonnet on Jev's pick (`return_up`), B3 went to Opus (override). B2 on Sonnet: 61,130 cache read (the shared system and tool prefix was already cached there) and **13,385 cache write** (the conversation itself). B3 on Opus: 74,398 cache read and 5,924 cache write, because side calls had kept Opus's copy of the whole conversation warm. So moving up one tier from a cheaper pin can pay a larger cache write than returning to the requested model, whose cache the harness maintains anyway; whether it is still cheaper overall depends on per-token prices and the turn's length. Not acted on; the report should show cache writes by move type (down, up one tier, back to requested) so Phase 2 can decide.

## 2026-09-19 — outcome signals, reconstructed for the earlier sessions

Outcome capture did not exist during shadow-1 and the route acceptance sessions. `scripts/spike/replay-transcripts.mjs` rebuilds the hook events those sessions would have produced from Claude Code's own local transcripts (main chat only; subagent transcripts are separate files and were not replayed) and runs them through the product tracker together with the logged decisions. Six of the seven logged sessions had a transcript.

| | shadow-1 | route (5 sessions) |
| --- | --- | --- |
| user prompts / logged main `new` turns / joined | 14 / 11 / 11 | 25 / 19 / 19 |
| `harness_injected` | 0 | 0 |
| correction score > 0 | 1 turn (score 1.0, rule `en:thats_wrong`) | 0 |
| `test_failure_after_edit` | 0 | 0 |
| reverted edits | 0 | 0 |

Every logged main-chat `new` turn joined to a user prompt; the one miss in a first pass came from the replay skipping a user-typed slash command, which does fire `UserPromptSubmit` (fixed in the replay). Test runs occurred (9 across the sessions) but none failed, and 4 turns contained edits, none undone. These sessions were short and mostly exploratory, so the absence of signals says little; the acceptance session is designed to trigger each one.

## 2026-09-19 — outcome capture acceptance (M4)

**Setup.** Interactive Claude Code 2.1.277 sessions with reflex in route mode and outcome hooks injected; the user made an edit, ran a failing test, corrected the assistant and had an edit reverted.

**Result.** Session 2 recorded `test_failure_after_edit` (runner `node-test`, exit code 1, one edit before it) on the turn that made the edit, and a subagent-scope outcome joined to that subagent's own decision record. `harness_injected` stayed at 0. The correction and the revert were recorded; one attribution issue is noted below.

**Finding: `UserPromptSubmit` fires for harness-injected messages too.** Two outcome windows in session 2 (turn seq 5 and 6) had no decision. Their prompts, identified afterwards from Claude Code's transcript because the worker had exited, were a message from another Claude session (transcript origin `peer`) and a background task notification (origin `task_notification`). The wire classified the same moments as `side` / `cross_session` and `side` / `notification`. Such windows now carry `no_decision: {reason: "no_wire_turn", nearest_wire: "side:cross_session"}` (the main-chat wire classification closest to the window's start). Prompts starting with `/` open no window at all. The same injected messages used to close the user's previous turn, so their text was read as that turn's correction; since `d4699c7` an injected prompt (recognised by `injectedPromptKind` in `src/wire`) keeps the user's window open, is counted in `counts.injected_prompts`, and is never scored. Session 2's records predate that fix.

**Attribution note (acceptance).** The `en:undo` match (0.8) landed on turn 3, the turn before the prompt that asked for the undo, while the revert that prompt triggered targeted turn 1. Recorded for Phase 2.
