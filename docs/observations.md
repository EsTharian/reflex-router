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

## 2026-09-19 — Jev latency with a kept-alive connection (archived sessions, read with `reflex report`)

**Setup.** The route-mode sessions archived after the keep-alive client and start-up warm-up landed (`route-1`, `route-3`, `m4-acceptance`; three sessions), Claude Code 2.1.277, Opus 5 requested, run from Turkey, Jev `jev-latest`. Numbers are the "6. Latency" section of `reflex report` over each file (nearest-rank percentiles; `m4-acceptance.jsonl` and the live `decisions.jsonl` are the same records and are counted once).

**Result.** All 11 decisions in those sessions reused the connection (`decision.connection: "reused"`): p50 382 ms, p95 408 ms (n = 11; by file: 6, 4 and 1 decisions). For comparison, the first dogfood session above used a fresh connection for each of its 12 decisions: p50 823 ms, p95 1,136 ms.

**Limits.** Different days, sessions, prompts and modes (shadow vs route), so this is not a controlled comparison of new vs reused connections; no decision in these sessions used a new connection, so there is no within-session contrast. Turns the cost guard refused before asking Jev are not decisions and are not in the sample. n = 11 says little about the tail. The live latency test (`npm run test:live`) is meant to measure new vs reused in one run; it has not been run yet (no key was available when it was written).

## 2026-09-19 — `reflex report` over the shadow dogfood session (excerpt)

**Setup.** `reflex report ~/.reflex/archive/shadow-1.jsonl` (v0.1.0 code) over the 61 records of the first dogfood session above: the M2 build, shadow mode, Opus 5 requested, Claude Code 2.1.277, run from Turkey, Jev `jev-latest`, a fresh connection per decision, and at that time the `argmax` rule with the 0.70 confidence floor (the `mass` rule came later). Sections 3 and 6, verbatim:

```
3. Shadow vs actual
  new turns that reached the backend (n=12); tokens = input + output + cache read + cache write of that turn's own request
    requested  would route to  turns  % turns  % tokens  actually sent there
    opus                haiku      5    41.7%     42.7%                    0
    opus               sonnet      1     8.3%      7.7%                    0
    opus                 opus      6    50.0%     49.6%                    6

  routed records (rewritten and accepted; includes pinned continuations): 0

6. Latency
  Jev decision latency (nearest-rank percentiles):
                            n     p50       p95
    all                    12  823 ms  1,136 ms
    connection not logged  12  823 ms  1,136 ms
```

**Reading.** Nothing was routed: shadow mode records what the plan would have done. "Would route to" is what the recorded plan said at the time, under that build's rule. "% tokens" is the share of the tokens of each cell's own request, not a saving: it says nothing about what the routed model would have cost or produced. One session, 12 decisions.

## 2026-09-19 — first real-work dogfood: where the tokens go (Phase 2 starting point)

**Setup.** Two Claude Code sessions on a company codebase (real work, not this repository), reflex v0.1.2 in shadow mode, Opus requested. Figures as reported by the maintainer from `reflex report` on that machine; the log itself stays there.

**Result.** 50 requests, 8.9M tokens. 2 user turns, 43 pinned tool-loop continuations, zero subagents. Both turns were judged `opus` (reasoning demand ≈ 2.95 of 0–4, confidence ≈ 0.9), so per-turn routing could have touched 0% of those tokens: a tool loop stays on the tier its turn started on. Two `unclassified` side calls consumed 452k tokens ($0.34 at list prices, about 3.5% of the sessions' usage). Outcome capture produced one window, so calibration has no data yet.

**Consequence.** Routing only pays where work starts a turn or a subagent. Phase 2a therefore adds (1) a workflow profile as the first section of `reflex report`, whose last line states at most how much of a log's tokens routing could have touched and how much of that is in subagents; (2) structural fingerprints for unclassified side calls, so they can be given a side kind; (3) an opt-in hint (`REFLEX_DELEGATE=1`) that asks Claude to delegate exploration to subagents, measured by the profile against total spend. Calibration (Phase 2b) waits for outcome data. A synthetic log of the same shape is a golden test (`test/fixtures/report/workflow-single-turn-long-loop.txt`). Two sessions, one codebase: this describes that work, not work in general.

## 2026-09-19 — the delegation hint reaches the request (REFLEX_DELEGATE=1)

**Setup.** `reflex -p "<one-line question>"` with `REFLEX_MODE=shadow REFLEX_DELEGATE=1`, the maintainer's own Claude Code settings (model setting `opus[1m]`, sent as `claude-opus-5` with the `context-1m-2025-08-07` beta; entrypoint `sdk-cli`; Claude Code 2.1.278; no `--model` or other override), reflex at the Phase 2a build. The Anthropic upstream was a local stand-in that recorded request bodies (never headers other than `anthropic-beta` and `user-agent`) and returned a canned reply, and the Jev URL pointed at a closed local port with a dummy key, so the run cost nothing and nothing left the machine. Betas seen: `claude-code-20250219, oauth-2025-04-20, context-1m-2025-08-07, interleaved-thinking-2025-05-14, thinking-token-count-2026-05-13, context-management-2025-06-27, prompt-caching-scope-2026-01-05, mid-conversation-system-2026-04-07, mid-conversation-tool-changes-2026-07-01, advisor-tool-2026-03-01, effort-2025-11-24, fallback-credit-2026-06-01, extended-cache-ttl-2025-04-11`.

**Result.** The hook was answered with the hint, a `delegate_hint` record was written, and the one model request carried the hint text verbatim at the end of its trailing `role:"system"` message, prefixed `UserPromptSubmit hook additional context:` (details: `docs/wire-format.md` §7). The decision record carried `delegate_hint: "delegate-1"`, its task sent to the backend was the 114-character prompt alone (the hint is not in it, nor in the preview), and the Jev failure was recorded as `backend:network` with the request forwarded unchanged.

**Not run.** The same command against the real API: the request was about 98 KB (68 KB of tool schemas), roughly 28–31k tokens, all marked for a 1-hour cache write (2× input, $10/M on Opus 5 at list price), so a cold run would cost about $0.28–0.31, at or over the $0.30 cap set for it. Whether the model follows the hint, and whether that pays, is what the week in route mode is for.

## 2026-09-19 — Dynamic Workflow (`ultracode`) on 2.1.278: what a fan-out costs, and why a polling cap cannot hold one

**Setup.** One interactive Claude Code 2.1.278 session on this repository, the maintainer's own settings (`opus[1m]`,
effort `medium`, no `--model` or other override), driven through a pty by `scripts/spike/pty-run.py` into the dump-only
capture proxy (`scripts/spike/capture.mjs`), permission mode `plan` (read-only), real Anthropic upstream. One prompt
containing the `ultracode` keyword, asking for a read-only review of `src/wire/` and `src/outcome/`. A first attempt
stalled on a permission prompt for the `Workflow` tool and was killed after $0.3735; the second attempt is the one
measured here. **The run was killed at the spend cap, mid-workflow**, so every figure below is a lower bound.

**Cost.** 22 requests with usage, 1,504,782 tokens, **$2.6491** at list prices (Opus 5, 1-hour cache writes), plus
$0.3735 for the abandoned first attempt: **$3.02 for one prompt**. Split by scope:

| scope | requests | tokens | $ | % tokens | % $ |
| --- | --- | --- | --- | --- | --- |
| main chat | 7 | 515,248 | 0.6707 | 34.2% | 25.3% |
| workflow workers | 15 | 989,534 | 1.9784 | 65.8% | 74.7% |

Four workers ran. Each worker's **first** request pays a cache write of its own context (58,976 tokens for the first;
~9,530 each for the next three, which reused the shared prefix), and every worker step after that pays a further
2,000–10,500 tokens of cache write. Worker traffic was **two thirds of the tokens and three quarters of the dollars**
in a run that never finished.

**A polling kill-switch cannot hold a cap against a parallel fan-out.** The run was guarded by a monitor that
re-priced the captured SSE usage every 18 seconds and killed the session above the cap. Between two consecutive polls
the session went from **4 requests / $0.44 to 21 requests / $2.55** — about **$2.10 committed inside one 18-second
sampling gap** — because the workers start together and each writes its context to the cache at once. By the time the
check fired the money was already spent; killing the process cannot recall requests that have been billed. The agreed
cap was $1.50 and the actual spend was $3.02, an overrun of $1.52.

The conclusion is structural, not a tuning problem: **a cap enforced by sampling is always one poll interval behind a
fan-out that can commit its whole budget in parallel.** A cap has to be enforced where the requests pass, before they
are forwarded. `capture.mjs` now does that (it refuses to forward once a running total crosses `--cap-usd`). The
product proxy does not yet, and a per-session spend guard for workflow fan-outs is an open plan item — Claude Code's
own 25-agent / 1.5M-token warning is disabled by the `ultracode` session setting, so a user who turns it on has no
ceiling from either side.

**This is the first measurement behind the README's warning that the delegation hint "can raise total spend."** The
hint asks for delegation one turn at a time; `ultracode` delegates by default and, on this one prompt, put 65.8% of the
tokens into workers. One session, one prompt, killed early: it bounds nothing, but it is a data point with a price tag.

**Wire findings** (fixtures `test/fixtures/claude-code/2.1.278/ultracode.*`, details in `docs/wire-format.md` §7.1):
workflow workers are ordinary subagents on the wire (header **and** `cc_is_subagent=true`), classified correctly with
no code change; they request the **session's own model** (`claude-opus-5`, effort `medium`), so the third-party claim
that workers use a stock model did not reproduce; hook `agent_type` is the new value `workflow-subagent`;
`SubagentStart` fired for each worker, `SubagentStop` was not observed **because the session was killed**; zero
requests were `unclassified`.

**Not possible: the 452k comparison.** The two 452k-token unclassified side calls from the company dogfood cannot be
compared against these. No archived log on this machine carries a `side_fingerprint` field at all — fingerprints landed
in v0.2.0-alpha, after every archived session — and the company log stays on that machine. The only two `unclassified`
side calls present locally are 38k and 71k tokens from this repository's own acceptance sessions.
