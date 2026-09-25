# Verification of nine anomaly claims against reflex 0.5.5/0.5.6 (2026-09-25)

The claims came from another machine's logs, session files and compiled `dist/`. None had been reproduced. Each was
treated as a hypothesis: prediction first, then a control, a repro and (where it rests on a line of code) a mutation.
Source lines below are `src/` at the named commit, not `dist/`.

**Versions.** reflex 0.5.5 = `5e00a2b`, 0.5.6 = `aba0bad` (both built in detached worktrees), fixes = `69ee6cc`,
`c4f5dd9`. Claude Code 2.1.282. Node 26.7. Owner's settings: `model: opus[1m]` (Opus 5.5 requested), `effortLevel:
medium`, four MCP servers, entrypoint `cli` (interactive) / `sdk-cli` (`-p`). No `--model` or settings override in any
`claude` invocation; the C4/C3 runs added `--allowedTools "Bash(sleep 20)"` so the subagent could run unattended.

**Rigs.**
- **A (no tokens).** `test/support/stack.ts` (real front door + supervisor + worker process), `fake-upstream.ts`,
  `fake-jev.ts` (tier, reasoning score and latency set per case), the 2.1.280 `print-agent.*` fixtures. Scenarios:
  `node --import tsx scripts/spike/claims-probe.mts c2 c3 c4 c4off c5 c6 c9`. Regression tests:
  `test/integration/side-calls.test.ts`, `test/unit/jev.test.ts`. For the real `claude` binary without tokens:
  `scripts/spike/fake-anthropic.mjs`.
- **B (real API).** The worktree builds with `REFLEX_HOME=<fresh dir>`, `REFLEX_UPSTREAM_URL=https://api.anthropic.com`,
  `REFLEX_JEV_BASE_URL=<loopback fake Jev>`, `TYPESAFE_API_KEY=apikey_fake`, `ANTHROPIC_BASE_URL` unset. Interactive
  runs through `scripts/spike/pty-run.py`. Usage from each home's `decisions.jsonl`, or `--output-format json`.
  Reflex-free runs through `scripts/spike/capture.mjs` (a dump-only proxy that never modifies a request).
- **Logs.** `~/.reflex/decisions.jsonl` on this machine (3,540 records, Claude Code 2.1.278–2.1.282) and the Claude Code
  transcripts under `~/.claude/projects/`. Read for structure and usage only.

## Summary

| Claim | Status | Evidence | Fix |
| --- | --- | --- | --- |
| C1 tool search off behind reflex | CONFIRMED on 0.5.5; already fixed in 0.5.6 (`7e8737b`, `740f8b6`) | A with real `claude`; mutation of `launch.ts:52`; earlier live runs | none needed |
| C2 explicit subagent model overridden | CONFIRMED | A (probe c2), test `side-calls` | yes (`c4f5dd9`) |
| C3 routed subagent's side calls on the requested model | CONFIRMED | A (c3), B live pair, log | yes (`c4f5dd9`) |
| C4 side calls lose effort marks, cache rewritten | CONFIRMED | A (c4/c4off), B live triple, log | yes (`c4f5dd9`) |
| C4b notifications/cross-session are real main turns | CONFIRMED (separate finding) | transcripts, B live | yes (`3de5903`) |
| C4c a subagent resumed after a background task loses its level | CONFIRMED (separate finding) | B dump + live | yes (`3de5903`) |
| C5 effort above the user's setting | CONFIRMED; kept by decision | A (c5) | none (owner's decision: may go above) |
| C6 decision wait and `maxSockets: 4` | CONFIRMED with a threshold | A (c6), log | yes (`69ee6cc`) |
| C7 429 at worker start | REFUTED (not caused by reflex) | B with and without reflex, fixture | none |
| C8 resume without reflex rewrites the cache | REFUTED as an extra cost (every resume rewrites it) | B interactive, three pairs | none |
| C9 resends | CONFIRMED (two upstream requests); billing not verifiable here | A (c9) | none; reasons below |

Real-API spend: **about 6.31M tokens, about $11.40** at list prices (estimate over recorded token counts), in two
rounds: $7.95 under a $10 cap stated beforehand, then $3.45 for the follow-ups without a cap stated first. Breakdown
at the end.

**Environment caveat.** The shell these runs started from was itself inside a Claude Code session, so every `claude`
inherited `CLAUDE_CODE_*` variables: `CLAUDE_EFFORT=medium` (the same as `effortLevel`), `CLAUDE_CODE_ENTRYPOINT=cli`,
and `CLAUDE_CODE_CHILD_SESSION`, which turns transcript saving off in interactive sessions. The interactive C8 runs
removed them all; the earlier runs did not.

## C1. Tool search off behind reflex

**Path.** `src/launcher/launch.ts:178` gives `claude` `ANTHROPIC_BASE_URL=http://127.0.0.1:<door>`. At 0.5.5
`launchEnv` returned only that. Claude Code treats a non-first-party base URL as "tool search off", so it sends every
tool with its full schema and no `ToolSearch`. At 0.5.6 `launch.ts:52` adds `ENABLE_TOOL_SEARCH=true` unless the user
set it.

**Prediction.** Real `claude -p` in front of a fake upstream: 0.5.5 and a direct run without the variable give no
`ToolSearch` and no `defer_loading`. 0.5.6, the work tree and a direct run with the variable give both.

**Runs** (`scripts/spike/fake-anthropic.mjs`, first tool-carrying request; `S` = scratch dir):

```
$ c1.sh direct-plain claude
$ ENABLE_TOOL_SEARCH=true c1.sh direct-ENABLE_TOOL_SEARCH claude
$ FAKE_AS=upstream c1.sh reflex-0.5.5 node $S/v055/bin/reflex.js     # REFLEX_MODE=shadow, fake key, REFLEX_UPSTREAM_URL=fake
direct-plain                tools 24 defer_loading 0 ToolSearch false mcp__ 0  tool bytes 67002
direct-ENABLE_TOOL_SEARCH   tools 12 defer_loading 1 ToolSearch true  mcp__ 0  tool bytes 26147
reflex-0.5.5                tools 43 defer_loading 0 ToolSearch false mcp__ 19 tool bytes 87216
reflex-0.5.6                tools 12 defer_loading 1 ToolSearch true  mcp__ 0  tool bytes 26147
reflex-worktree             tools 15 defer_loading 4 ToolSearch true  mcp__ 3  tool bytes 27799
```

The MCP counts vary from run to run because the MCP servers connect at different times. The pattern does not vary.
Without reflex there is no loopback comparison (first-party cannot be faked). The live first-party figures are in
`docs/observations.md` (2026-09-25): 28,376 input tokens without reflex, 44,456 behind 0.5.5, 28,167 with the variable.

**Mutation.** Drop the variable from `launch.ts:52` in the work tree:

```
reflex-worktree-MUTATED     tools 24 defer_loading 0 ToolSearch false mcp__ 0 tool bytes 67002
test/integration/launch.test.ts: ✖ turns MCP tool search back on behind the proxy, and never overrides a value the user set
reflex-worktree-restored    tools 15 defer_loading 4 ToolSearch true  mcp__ 3 tool bytes 27799   (33/33 pass)
```

**Extra check (Haiku retarget with tool search).** Not re-run. The earlier live experiment
(`test/fixtures/claude-code/2.1.282/experiment.toolsearch-route.results.json`, `reflex:haiku`/`reflex:sonnet`, a
`ToolSearch` → `CronList` → MCP `guide` chain) has every routed request accepted with the fix. Before the fix the first
request was rejected (400, `tool_addition`). `test/integration/route.test.ts` "MCP tool search survives the proxy"
pins it.

**Result.** CONFIRMED for 0.5.5; fixed in 0.5.6.

## C2. An explicitly chosen subagent model is overridden

**Path.** `src/wire/claude-code.ts` classifies a subagent's first request as `new`. `src/worker/router.ts#decide`
(0.5.6: lines 528–597) asks the backend, and `plan()` (`src/policy.ts:188-196`) moves it. Nothing on the wire says
whether the Agent call named a model: the request only carries the resulting `model`. The `PreToolUse` hook
(matcher `Agent|Task`, `src/outcome/hooks-config.ts:14`) does carry `tool_input.model`, and a 2.1.282 capture
(`model: "haiku"`) shows it. At 0.5.6, however, `parseHookEvent` (`src/outcome/hooks.ts:80-85`) dropped it.

**Prediction.** (a) inherit Opus, Jev sonnet → Sonnet. (b) `model: sonnet`, Jev opus → Sonnet with upgrades off, Opus
with `REFLEX_UPGRADES=on` (the owner's setting). (c) `model: opus`, Jev sonnet → Sonnet. The hook arrives (204) and
changes nothing.

**Repro** (`claims-probe.mts c2`, 0.5.6 code):

```
C2 upgrades=off (a) no model, inherits opus: requested claude-opus-5-5, jev sonnet -> upstream model claude-sonnet-5; hook status 204; plan.reasons ["downgrade"]
C2 upgrades=off (b) model: sonnet: requested claude-sonnet-5, jev opus -> upstream model claude-sonnet-5; hook status 204; plan.reasons ["upgrade_disabled"]
C2 upgrades=off (c) model: opus: requested claude-opus-5-5, jev sonnet -> upstream model claude-sonnet-5; hook status 204; plan.reasons ["downgrade"]
C2 upgrades=on (b) model: sonnet: requested claude-sonnet-5, jev opus -> upstream model claude-opus-5-5; hook status 204; plan.reasons ["upgrade"]
C2 upgrades=on (c) model: opus: requested claude-opus-5-5, jev sonnet -> upstream model claude-sonnet-5; hook status 204; plan.reasons ["downgrade"]
```

**Control.** Case (a) is the control. With nothing explicit, routing is the intended behaviour.

**Fix** (`c4f5dd9`). `hooks.ts` reads `tool_input.model` (`inherit` counts as none). `server.ts` keeps it in memory,
keyed by session + prompt hash (the same key the status line uses for titles). `router.ts#decide` returns
`model_explicit` for such a subagent before asking the backend. After:

```
C2 upgrades=on (a) ... -> upstream model claude-sonnet-5; plan.reasons ["downgrade"]
C2 upgrades=on (b) ... -> upstream model claude-sonnet-5; plan.reasons ["model_explicit"]
C2 upgrades=on (c) ... -> upstream model claude-opus-5-5; plan.reasons ["model_explicit"]
```

**Test and mutation.** `side-calls.test.ts` "a subagent the Agent call gave a model explicitly runs on it". Removing
the router line → ✖. Making `hooks.ts` return `model: null` → ✖. Both restored → green.

**Agent definitions** (`3de5903`). A model set in an agent definition's frontmatter, or a built-in agent's own model, is
not in `tool_input`. Such a subagent asks for a different model from the main chat's, which is the signal: a subagent
whose requested tier differs from the main chat's latest is not decided either. Log: of 171 subagent starts, 30 asked
for another tier than their main chat (26 Sonnet, 4 Haiku). One frontmatter `model:` naming the main chat's own tier
is still indistinguishable from inheriting and is routed. Test "a subagent asking for another tier than the main chat
… not routed"; removing the comparison → ✖. An explicit-model subagent also keeps its effort level, because the whole
decision is skipped.

## C3. A routed subagent's side calls stay on the requested model

**Path.** `router.ts:257` (0.5.6) set `conv = null` for `turn === "side"`. The pin branch (`:305-338`) only handles
`new` and `continuation`, so an `agent_summary` ("Describe your most recent action…", sent under the subagent's agent
id) went out unchanged.

**Prediction.** Subagent pinned to Sonnet: new/continuation go to Sonnet, the summary goes to Opus.

**Repro A** (`c3`, 0.5.6): `new → sonnet`, `continuation → sonnet`, `agent_summary → claude-opus-5-5`,
`continuation → sonnet`.

**Repro B** (live, fake Jev `sonnet`, multi-step subagent, `REFLEX_EFFORT` off). Before (0.5.6), the summaries on Opus:

```
{"turn":"new","model":"claude-sonnet-5","read":0,"create":31566}
{"side":"agent_summary","model":"claude-opus-5-5","read":16633,"create":14955,"input":2119}
{"side":"agent_summary","model":"claude-opus-5-5","read":31588,"create":1996}
{"side":"agent_summary","model":"claude-opus-5-5","read":33584,"create":204}
```

After (work tree), the summaries on Sonnet, all 200, no fallback. The last one was cut by `/exit`:

```
{"turn":"new","model":"claude-sonnet-5","read":0,"create":32469}
{"side":"agent_summary","model":"claude-sonnet-5","read":32469,"create":104,"input":2118}
{"side":"agent_summary","model":"claude-sonnet-5","read":34480,"create":88}
{"side":"agent_summary","model":"claude-sonnet-5","read":34581,"create":88}
```

**Log.** Subagent `agent_summary` calls whose conversation's last request went to a different model: 26 calls, 448,195
cache-write tokens (17.2k each). With the same model and no effort edit: 176 calls, 519,409 (3.0k each).

**Fix** (`c4f5dd9`). A side call looks up its conversation read-only (`sideConv`). An `agent_summary` of a pinned
subagent is retargeted to the pin (verified pairs only; a rejection falls back as for any rewrite). The pin itself is
never moved by a side call. Other side kinds are unchanged.

**Test and mutation.** `side-calls.test.ts` "a pinned subagent's progress summary follows the pin". The old
`route.test.ts` case that pinned the passthrough is replaced ("follows the pin (…) no Jev call" + "an unpinned
subagent's summary passes through unchanged"). Removing the retarget line → ✖.

## C4. Side calls lose the effort marks; the cache is rewritten

**Path.** 0.5.6 `router.ts:257`: `conv = null` for side calls, and the effort block at `:348` ran only `if (conv)`. So
`withEffort` (`src/wire/effort.ts:93-153`), which re-applies every stored mark by history hash, never ran for a side
call. With `REFLEX_EFFORT`, a subagent's first request gets `set` (its own index-1 system message changed to reflex's
level) and every continuation re-applies it. A side call replays the same history with Claude Code's own level on
message 1, so the prefix differs from index 1 on.

**Prediction.** Every side kind first differs from the previous continuation at index 1 (`system:low` vs
`system:medium`). With `REFLEX_EFFORT` off there is no difference.

**Repro A** (`c4` vs `c4off`, 0.5.6):

```
C4 effort=true  main suggestion        turn=side/suggestion fields [] first divergence vs continuation: index 1 (prev system:low vs side system:medium)
C4 effort=true  main cross_session     ... index 1 (prev system:low vs side system:medium)
C4 effort=true  main task_notification ... index 1 (...)      C4 effort=true main session_recap ... index 1 (...)
C4 effort=true  main tool_result_text  ... index 1 (...)      C4 effort=true subagent agent_summary ... index 1 (...)
C4 effort=false (all six)              first divergence vs continuation: none in the shared 5 messages
```

**Repro B** (live; fake Jev `opus`, reasoning 0 → `low` against the client's `medium`; a subagent runs `sleep 20` five
times; `agent_summary` rows only):

| run | code, `REFLEX_EFFORT` | summaries: cache read / write |
| --- | --- | --- |
| repro | 0.5.6, on | 16,633 / 0 (+16,026 uncached input); 16,633 / 17,900; 34,533 / 190 |
| control | 0.5.6, off | 32,186 / 82; 34,175 / 82; 34,365 / 82 |
| after the fix | work tree, on | 31,498 / 88; 33,493 / 88; 33,695 / 88 |

16,633 is the subagent's fixed system + tools prefix. In the repro the summaries fall back to it and write the history
again into a second chain, which later summaries then read. A first single-subagent run on 0.5.6 showed the same
thing: read 16,799 / write 21,534.

**Log.** Subagent summaries after an effort-edited request: 7 calls, 147,027 written (21k each), 4 of 7 wrote more than
they read. Without an edit: 3.0k written each.

**Fix** (`c4f5dd9`). The effort block runs for side calls too, with nothing new to add: stored marks are re-applied
(`withEffort(..., add = null)`), and a Sonnet conversation's top-level level is kept through `sideConv`. With no mark
the body stays byte-identical ("a side call in a conversation reflex never changed goes out byte for byte"). After, in
A: every side kind shows "first divergence: none".

**Test and mutation.** `side-calls.test.ts` "every side call carries the effort marks…". Putting back `if (conv)` → ✖.

### C4c. A subagent resumed after a background task

In two live runs the subagent ran its `sleep` in the background, and a subagent `notification` side call wrote about
18.7k even with `REFLEX_EFFORT` off (read 16,633 / write 18,739). A dump of every request body (`scripts/spike/dump-proxy.mjs`, a loopback proxy
between reflex and the API, bodies only) shows why: when the background task ends, Claude Code rebuilds the waiting
subagent. The `x-anthropic-billing-header` system block changes, and message 0 loses its task-text block (5 text
blocks become 4). The cache misses from message 0 on, with or without reflex, and nothing in reflex can prevent that.
What reflex did wrong: its effort mark is keyed by the hash of the history, so it stopped matching, and the rest of the
loop silently ran at the client's level (`medium` instead of the decided `low`).

**Fix** (`3de5903`). The conversation remembers the level reflex set on its first effort-bearing system message
(`effortFirst`, memory only). When no mark matches that message any more, `withEffort(..., keepFirst)` sets it again
there and returns it as a new `set` mark (`messages.effort_kept`). That request already misses the cache, so the edit
costs nothing. Live (Opus 5.5, fake Jev `low`):

```
{"turn":"new","fields":["messages.effort_set","output_config.effort"],"read":16633,"create":15815}
{"turn":"continuation","fields":["messages.effort_reinserted:1","output_config.effort"],"read":32448,"create":2134}
{"turn":"side","marker":"task_notification","fields":["messages.effort_kept","output_config.effort"],"read":16633,"create":18303}
{"turn":"continuation","fields":["messages.effort_reinserted:1","output_config.effort"],"read":34936,"create":109}
```

Tests: `effort.test.ts` "keepFirst: a history Claude Code rebuilt …" and `side-calls.test.ts` "when Claude Code
rebuilds a subagent's history …". Mutations (keep branch off; router not passing it; level never recorded) → ✖ each.

### C4b. `task_notification`, `cross_session`: side calls, or turns?

Claude Code transcripts on this machine (`~/.claude/projects/*/*.jsonl`, structure only). A user message carrying
`<task-notification>` (origin `task-notification`): 99, of which 92 were answered by a non-sidechain assistant message
in the main transcript. `Another Claude session sent a message:` (origin `peer`, the subagent hand-back): 46, of which
45 were answered in the main chat. These are real main-chat turns. `src/wire/markers.ts:77-91` names them side kinds,
so they are never decided and never follow the main chat's pin (they go to the requested model while the chat may run
elsewhere). `tool_result_text` does not show in transcripts (tool results are stored on their own), but by shape it is
the loop's next step: a tool result has to be answered in the loop that asked for it.

**Fix** (`3de5903`). `followsPin` (`src/wire/claude-code.ts`) names the side calls that go where their conversation's
pin sends it: `agent_summary`, `tool_result_text`, `cross_session`, and the `task_notification` marker (main chat and
subagent). They are still never decided, and the pin is only read. Suggestions, recaps, compaction and title calls are
unchanged. Live, main chat pinned to Sonnet (fake Jev: main `sonnet`, subagent `opus`):

```
{"kind":"main","turn":"new","model":"claude-sonnet-5","read":0,"create":43994}
{"kind":"main","turn":"side","marker":"task_notification","model":"claude-sonnet-5","read":44788,"create":377}
{"kind":"main","turn":"side","marker":"cross_session","model":"claude-sonnet-5","read":45165,"create":387}
{"kind":"main","turn":"side","marker":"task_notification","model":"claude-sonnet-5","read":45552,"create":563}
```

All 200, no fallback. Test "a main chat's task notifications, hand-backs and tool steps with harness text follow its
pin; a suggestion does not"; narrowing `followsPin` to summaries → ✖.

**Seen, not reflex's.** In the same session Claude Code sent a tool-less side call on `claude-sonnet-5` itself (not
rewritten, 127k characters of system text, two user messages) that wrote 47,026 tokens. It is Claude Code's own call
on a model it chose; reflex forwards it unchanged.

## C5. Effort above the user's setting

**Path.** `src/policy.ts:205-212` (`effortPlan`): with `up` (`REFLEX_EFFORT_UP`) a reasoning demand above the client's
level is used as is, up to `max`. The client's level is the request's own `output_config.effort`, which is the
settings value (`effortLevel: medium`).

**Runs** (`c5`, reasoning 3.9):

```
C5 effortUp=false: client medium -> upstream top medium, message medium; effort {"pick":"max","target":"medium","reasons":["effort_up_disabled"]}
C5 effortUp=true:  client medium -> upstream top max, message max;       effort {"pick":"max","target":"max","reasons":["effort_up"]}
```

**Result.** CONFIRMED, and kept. This is what the flag is for, and the owner's `~/.reflex/env` sets it. Owner's
decision (2026-09-25): effort may go above the user's own level, because a user who does not know how much effort a
task needs is better served by a level set for that task. Nothing changed; the status line already shows a level
above the requested one (`Effort: ⇡ …`).

## C6. Decision wait and `maxSockets: 4`

**Path.** A route-mode `new` turn waits for its decision in `router.ts#bounded`, bounded at `decisionDeadlineMs` +
`DECISION_GRACE_MS` (1,500 + 250 ms). The Jev client's deadline timer starts in `decide()` (`src/backend/jev.ts`), so
time spent waiting for a socket counts. The agent had `maxSockets: 4` (0.5.6 `jev.ts:122`).

**Prediction.** At 400 ms Jev latency, requests 5–8 wait about 800 ms and none is late. At 800 ms, requests 5–8 would
end at about 1,600 ms, past the 1,500 ms backend deadline, and time out.

**Repro** (`c6`, 0.5.6):

```
jev 400 ms: 1 → [406]; 4 → [407..413]; 6 → [406,408,408,409,806,809]; 8 → [406..410, 807..814]; late 0/8
jev 800 ms: 1 → [808]; 4 → [807..811]; 6 → [...,1504,1506] timeout 2/6; 8 → [807..811, 1506..1512] timeout 4/8
```

**Log.** Jev latency p50 365 ms, p90 767 ms, p99 1,268 ms (n = 576). Subagent decisions that timed out: 0/18 when one
started alone; 8/28 with four and 22/79 with five or more starting within ±1.5 s. Main chat: 6/456. Part of that
effect may be the server's own latency under load; the queue alone explains the fake-Jev runs.

**Fix** (`69ee6cc`): no socket cap (idle sockets kept: 2). After: `jev 800 ms, 8 → [806..814], timeout 0/8`.

**Test and mutation.** `jev.test.ts` "decisions started together are all answered within the deadline" (8 × 180 ms,
300 ms deadline). Putting back `maxSockets: 4` → ✖.

## C7. 429 at worker start

**Log.** 37 records with status 429 in this machine's log. Every one is the first request of its session:
`kind: unknown`, `side_kind: no_tools`, not rewritten, 0.4–1.2 s to headers.

**Runs** (interactive start then `/exit`, twice each):

```
with reflex (work tree, shadow):  {"kind":"unknown","turn":"side","side_kind":"no_tools","model":"claude-opus-5-5","rewritten":false,"status":429} ×2
without reflex (capture.mjs, dump-only): {"model":"claude-opus-5-5","max_tokens":1,"tools":0,"system":false} status 429 ×2
                                    body: {"type":"error","error":{"type":"rate_limit_error","message":"Error"}}, x-should-retry: true
```

Claude Code's startup quota probe (`max_tokens: 1`, no system, no tools) is answered 429 without reflex too. The
2.1.277 fixture `interactive.quota-probe`, captured before reflex existed, has the same status. Nothing in reflex
touches this request. No mutation: the claim rests on no reflex line.

**Result.** REFUTED as a reflex effect.

## C8. Resuming without reflex after an effort edit

**Path.** A main chat with `REFLEX_EFFORT_MIDTURN` gets `set` on its first turn. Only reflex re-applies it
(`effort-store.ts`, `withEffort`). A plain `claude --continue` sends Claude Code's own level at index 1, so the prefix
differs there. That much is deterministic (the A repro above for side calls; `test/unit/effort.test.ts`, the fresh
worker case).

**First attempt** (`-p`, fake Jev `low`, one turn each):

| pair | turn 1 | turn 2 (`--continue`) read / write |
| --- | --- | --- |
| repro | reflex (`messages.effort_set`) | plain: 11,766 / 9,905 |
| control | plain | plain: 11,962 / 12,349 |
| reflex both | reflex | reflex: 11,767 / 12,088 |

In all three pairs turn 2 read only the fixed prefix. The control misses as well, so this rig cannot separate the
claimed effect. A capture of a plain pair showed why: `tools` differed between the two `-p` processes, since the MCP
servers connected at different moments. Through the capture proxy (tool search off) both turns wrote about 45k with no
read at all.

**Interactive runs.** Each run was a fresh folder with the trust prompt accepted, one typed turn, then `/exit`; the
second process ran `claude --continue`. The inherited `CLAUDE_CODE_*` variables were removed, so transcripts were
saved. Usage comes from the Claude Code transcript (both turns in one file each time).

| pair | turn 1 read / write | turn 2 (`--continue`) read / write |
| --- | --- | --- |
| repro: reflex (`effort_set`), then plain | 26,288 / 12,789 | 26,288 / 12,831 |
| control: plain, then plain | 26,486 / 12,798 | 26,486 / 12,840 |
| reflex, then reflex (`effort_reinserted:1`) | 24,095 / 14,975 | 26,287 / 12,800 |

Every resume in a new process read only the fixed prefix and wrote the conversation again, with or without reflex.
The reflex→reflex pair had its mark re-applied, which shows the history really did continue. The claimed rewrite
happens, but it happens on every resume anyway: continuing without reflex added nothing measurable (12,831 against
12,840).

**Result.** REFUTED as a cost caused by reflex. The README sentence "(it would cost one cache rewrite)" describes a
rewrite that resuming costs anyway; it stays, qualified in `docs/reference.md`.

## C9. Resends

**Path.** `src/worker/server.ts:223-232`: a rewritten request answered with a 4xx other than 401/403/408/429
(`isRejection`, `:89`) is sent again with the original bytes. `src/launcher/front-door.ts:110-139`: if the connection
to the worker fails before any response byte, the same bytes go straight upstream.

**Runs** (`c9`):

```
C9(1) rewrite rejected with 400: client got 200; upstream saw 2 requests: claude-sonnet-5, claude-opus-5-5
C9(2) kill worker mid-request=false: client got 200; upstream saw 1 requests
C9(2) kill worker mid-request=true:  client got 200; upstream saw 2 requests; door counters {"viaWorker":2,"direct":1,...}
```

**Result.** CONFIRMED: two requests reach the upstream in both cases. No mutation was needed: the resend is the
documented fail-open path. Whether either is billed twice cannot be verified from here: Anthropic reports usage only
inside a response, and the aborted first request never returns one. There is no per-request bill to read. (1) A 400 carries no usage, so it is not
billed. (2) The first request's connection closes when the worker dies, and whether Anthropic bills a request aborted
before its headers is not observable here. **No fix.** Without the door's resend the client would get a 502, and
Claude Code retries 5xx itself, which also sends the request twice. Case (2) needs a worker crash.
`~/.reflex/worker.log` has 121 worker starts, and most are session starts.

## Spend (B)

| runs | tokens | list-price estimate |
| --- | --- | --- |
| C4 (8 interactive runs, four without a summary) | 3,464,076 | $4.93 |
| C3 (2 interactive runs) | 1,070,720 | $2.06 |
| C8 through reflex (4 turns) | 68,531 | $0.31 |
| C8 plain (3 turns) + capture pair (2 turns) | 160,577 | $0.66 |
| C7 (4 quota probes, all 429) | 0 | $0 |
| round 1 total | 4,763,904 | $7.95 |
| C4c dump run, C4b/C4c live runs (3 interactive) | 1,221,418 | $2.51 |
| C8 interactive through reflex (4 turns; one in the repo folder, discarded) | 164,732 | $0.50 |
| C8 interactive plain (3 turns + 1 screen-capture turn) | ~157,000 | ~$0.43 |
| round 2 total | ~1,543,000 | ~$3.45 |
| **total** | **~6,307,000** | **about $11.40** |

Rates from `src/pricing.ts` (last verified 2026-09-24), cache writes at the 1-hour rate. An estimate, not a bill.
