# reflex-router

**Model routers ask "which model?" reflex asks: how should this work be done, was it done right, and what did we learn?**

`reflex` runs the real [Claude Code](https://docs.claude.com/en/docs/claude-code) behind a loopback proxy and does three things with it:

1. **Decide.** At the start of each piece of work, a fast decision model ([TypeSafe Jev](https://docs.typesafe.ai)) judges how much *reasoning* the task demands, not how long the message is.
2. **Route** (opt-in). When it is safe, and does not throw away the conversation's prompt cache for nothing, send the work to a cheaper model. Otherwise leave it exactly as it was.
3. **Observe.** For every decision, record whether it looked wrong afterwards (the next prompt reads like a correction, a test failed after an edit, an edit was undone) and read the result back with `reflex report`.

What v0.1.0 does **not** do yet, so you don't have to find out: it decides the model tier only (not reasoning effort), it records outcome signals but nothing acts on them yet, and **we have not measured a cost saving**. See [What we have measured](#what-we-have-measured) and [Benchmarks](#benchmarks).

## How it works

```
   you ──► claude ──► reflex (127.0.0.1) ─────────────────► api.anthropic.com
          (unchanged)  front door + worker                   your credentials,
                            │                                forwarded untouched
                            │  start of work only:
                            │  redacted task text, capped
                            ▼
                       TypeSafe Jev
                       (decision backend)
```

`claude` is started with its base URL pointed at reflex. A small front door owns the loopback port for the whole session and hands each request to a supervised worker; if the worker fails, the door forwards the request straight to the API. Claude Code's own hooks post to the same loopback door for outcome capture.

**Decide → route → observe:**

- **Decide.** Only a positively identified start of work is sent to Jev: a prompt you typed in the main chat, or a subagent's first request. Tool-loop steps and Claude Code's own side calls (suggestions, summaries, notifications) never are. One backend call asks two questions: the least capable tier that will still do the task well (Haiku, Sonnet or Opus), and how much reasoning it demands.
- **Route.** In `shadow` mode (the default) every request is forwarded byte for byte and reflex only records what it *would* have done. In `route` mode a request can be rewritten for a cheaper model, but only for retargets verified against the API: Sonnet → Haiku, Opus → Sonnet, Opus → Haiku. A **subagent** is decided at its first request and pinned to that model for its whole tool loop. The **main chat** is only switched behind a cost guard, because switching model discards the conversation's prompt cache (measured in [`docs/observations.md`](docs/observations.md), below). If the API rejects a rewritten request, reflex re-sends your original bytes.
- **Observe.** Each decided turn gets an outcome window. Reflex records a correction score with the matched rule ids (not a verdict), a failing test run after an edit in the turn, and edits undone within three turns. Prompt text, commands, paths and code from the hooks stay in memory; the log gets hashes, counts and rule ids.

**Ground rules** (enforced by tests): fail open, so any error, timeout or surprise ends in forwarding your request unchanged; byte-identical passthrough unless a rewrite was deliberately applied; your Anthropic credentials are never read, stored or logged; loopback only; your `~/.claude/settings.json` is never edited (reflex passes one temporary `--settings` file and deletes it on exit); zero runtime dependencies (TypeScript, Node 20+).

## Quick start

reflex is not on npm yet. Install from a checkout:

```sh
git clone https://github.com/ziyacivan/reflex-router && cd reflex-router
npm ci && npm run build && npm link      # puts `reflex` on your PATH (Node.js 20+)
```

Give it a Jev key, either in the environment or in a file that survives new shells:

```sh
export TYPESAFE_API_KEY=apikey_...
# or
mkdir -p ~/.reflex && (umask 077; echo 'TYPESAFE_API_KEY=apikey_...' > ~/.reflex/env)
reflex doctor        # what it would do, and where each setting came from
```

`~/.reflex/env` holds `KEY=value` lines for `REFLEX_*` settings and the key. It is merged **under** your environment (the environment wins), and a file that holds the key but is readable by group or others is refused: reflex warns, ignores the file, and runs plain `claude`. `reflex doctor` says why.

**Start in shadow mode, and look before you route:**

1. `reflex` (everything you type after it goes to `claude` untouched). The default mode is `shadow`: nothing about your session changes, and `~/.reflex/decisions.jsonl` fills up.
2. Work as usual for a few sessions, then `reflex report` (`--since 2h`, `--usd`). Read section 3, "shadow vs actual": what reflex *would* have routed where.
3. When you are happy with that, opt in: `REFLEX_MODE=route reflex`. To route only subagent work and leave the main chat alone, add `REFLEX_MAIN_CHAT=never`.
4. `REFLEX_MODE=off reflex` is literally plain `claude`, with no proxy at all.

Here is what the report looks like. This is real output (`reflex report` on the archived first dogfood session, sections 3 and 6), with its conditions in [`docs/observations.md`](docs/observations.md#2026-09-19--reflex-report-over-the-shadow-dogfood-session-excerpt): one shadow session, 12 decisions, nothing was routed, and "% tokens" is the token share of each cell's own request, **not a saving**.

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

The full report has ten sections: decisions by kind and tier; `mass` vs `argmax`; shadow vs actual; guard refusals; fallbacks and breaker; latency (Jev by new vs reused connection, the decision wait and the upstream's first byte); outcome rates for routed vs unchanged turns, with sample sizes and an explicit "insufficient data" line below 20 windows; cost at list prices; side-call usage on its own line; and cache writes by move type. `reflex report --json` prints the same sections as one JSON object, keyed by section number, for scripting against. Settings, route-mode details and safety nets: [`docs/reference.md`](docs/reference.md).

## How it compares

Capabilities only. This table has no speed or savings figures, ours or theirs, and it does not claim reflex is better on any number. It compares reflex-router with two existing Claude Code routers as we read them in [`docs/prior-art.md`](docs/prior-art.md) (their READMEs and code at the commits named there); both projects move, so check theirs: [jev-router](https://github.com/gargpratyush/jev-router/blob/0d39e5b/README.md) (`0d39e5b`) and [jcm-router](https://github.com/adarshmishra07/jcm-router/blob/083df7f/README.md) (`083df7f`).

| Capability | reflex-router v0.1.0 | jev-router | jcm-router |
| --- | --- | --- | --- |
| Outcome capture (correction, failing test after an edit, reverted edit, per decision) | Yes, **record-only**: nothing acts on it yet | Not in what we read; cost only ([§5](docs/prior-art.md#5-what-reflex-router-does-differently)) | Not in what we read; cost only ([§5](docs/prior-art.md#5-what-reflex-router-does-differently)) |
| Quality-aware reporting | `reflex report`: outcome signals for routed vs unchanged turns with sample sizes, next to a stated cost estimate | Status line showing scores (display only, [§3](docs/prior-art.md#3-jev-router)) | Dashboard of cost, cache health and Jev latency; offline eval of decisions on hand-labelled prompts ([§2](docs/prior-art.md#2-jcm-router)) |
| Shadow mode | Default mode; report compares would-route with actual | No | `dry_run` |
| Pluggable / local decision backend | `DecisionBackend` interface; only Jev is implemented, the local backend is a placeholder | Jev only | Jev only |
| Per-agent pins | Pin per conversation, and per subagent id; state is session-scoped | State per session + first message, reused through the tool loop; no explicit subagent signal | Reuses the most recent routed turn's decision; subagents detected from the system prompt; turn key is prompt-based ([§2](docs/prior-art.md#2-jcm-router)) |
| Cost guard | Yes: refuses a main-chat switch whose lost prompt cache would cost more than a limit (list prices) | No cost model; a fixed context-size rule | Yes: cache-aware, with a maximum switch cost |
| Privacy controls | Allow-listed state sent to the backend, character budgets and secret redaction before anything leaves the machine, log files `0600` in a `0700` directory and size-rotated, a redacted 300-character prompt preview (on by default, switchable) | README says only the prompt is sent; the code also sends model, context size and available models ([§3](docs/prior-art.md#3-jev-router)) | Journal keeps a 300-character prompt preview by default (switchable) and is not rotated ([§2](docs/prior-art.md#2-jcm-router)) |

What they have that reflex does not: jcm-router has a live dashboard; jev-router has a status line and a custom model picker. reflex's report is plain text. Ideas we took from both (retry with the original request when a rewrite is rejected, byte-identical forwarding, pinning through a tool loop) are credited in [`THIRD_PARTY.md`](THIRD_PARTY.md); no code was copied.

## What leaves your machine

Full detail: [`docs/privacy.md`](docs/privacy.md).

- **To the decision backend (TypeSafe Jev):** only for the start of work. The request is `{state, model, questions}`; `state` has exactly four fields: your prompt (or a subagent's delegation prompt), and for the main chat the tail of the assistant's previous message, plus the requested tier and whether it is a subagent. Text is truncated first (by default 4,000 characters of your prompt, head and tail, and 1,000 of the assistant's reply; both settings), then redacted: API keys and tokens, `.env`-style `NAME=value` lines, private keys, and home-directory prefixes. Redaction is best effort, not a guarantee. No system prompt, tool list, tool results, file contents, session or device ids, headers or Anthropic credentials. Your TypeSafe key goes only in the `Authorization` header to TypeSafe. At start-up the worker also sends one bare `HEAD /` to open the connection early; it carries no key and no data.
- **To Anthropic:** your request with your own headers. In `shadow` mode it is byte for byte. In `route` mode a routed request has its model id and dependent fields rewritten (the changed fields are listed in its record), and no text is added, removed or edited. The one exception is opt-in: with `REFLEX_DELEGATE=1`, Claude Code itself adds reflex's fixed delegation hint (below) to each prompt you type. No `REFLEX_*` or `TYPESAFE_*` value ever reaches Anthropic.
- **On disk (`~/.reflex/`):** one JSON record per classified request, session ids hashed, plus a **redacted preview of at most 300 characters of each decided prompt, on by default** so decisions can be reviewed; that default will be revisited before a public release, and `REFLEX_LOG_PROMPTS=0` removes it. Redaction does not remove project-relative paths or your own words from the preview. Outcome records hold hashes, counts, rule ids and test-runner kinds, never prompt text, commands, paths or code.

## Delegation hint (opt-in experiment)

Per-turn routing can only reach work that starts a turn or a subagent. In long single-turn sessions most tokens sit in the main chat's tool loop, which stays on the model the turn started on, so `reflex report` starts with a workflow profile: where your tokens went (new turns, tool-loop continuations, subagents, side calls) and at most how much of them routing could have touched.

`REFLEX_DELEGATE=1` (off by default; `shadow` or `route` mode) is an experiment in moving work into subagents, where routing applies. On every prompt you type (not on slash commands, Claude Code's own injected messages or subagent hand-backs), reflex's `UserPromptSubmit` hook answers with a fixed three-line hint, as hook context, asking Claude to hand exploration, multi-file reading, searches and test runs to subagents and keep the main conversation for synthesis and edits. The text is in [`src/delegate/hint.ts`](src/delegate/hint.ts); its version id is logged on every decision record of the session. If the worker is down or anything fails, the hook gets no answer and the prompt goes on without the hint.

**Risk: delegation can raise your total spend.** A subagent starts with its own context and re-reads files and state the main conversation may already hold, and Claude Code's side calls continue as before. More delegation is only a win if the cheaper tiers it enables outweigh that. The workflow profile and the cost section show total tokens and dollars per user turn with and without the hint, with the number of sessions on each side, so you can see whether it paid on your work; we have no measurement of that yet.

## Overrides, ceilings and known limits

- **Overrides.** Start a prompt with `reflex:haiku`, `reflex:sonnet` or `reflex:opus` to choose the model for that turn and the subagents it spawns. `!`, `/`, `@` and `#` are not used because Claude Code consumes them (`!` is bash mode). An override skips the backend, the confidence rule and the main-chat cost guard: it is your explicit choice, so it can pay the cache penalty the guard would have refused. The token stays in your prompt; reflex never edits prompt text.
- **Haiku context ceiling.** Work is not routed to Haiku when the request's estimated context exceeds 150,000 tokens (a fixed setting in `src/tiers.ts` chosen to leave room in Haiku's window, not a measurement); it goes to the next tier up, or stays as it was.
- **`opus[1m]` sessions.** Haiku does not accept the long-context beta, so the `context-1m-*` beta is removed from the request when it is retargeted to Haiku; the rest of the header is kept. Without that the API answered 400, and reflex's fallback then re-sent the original request ([`docs/acceptance-phase1.md`](docs/acceptance-phase1.md), item 6).
- **Side calls keep billing the requested model.** Claude Code's own side calls are never rewritten, so part of a routed session's usage stays on the model you asked for, by construction. In route session B ([`docs/observations.md`](docs/observations.md)) they also kept that model's prompt cache warm while the conversation itself ran elsewhere.
- **Only verified retargets are applied.** Sonnet → Haiku, Opus → Sonnet, Opus → Haiku. Upgrades above the requested model and Fable retargets are recorded and left alone. Opus → Sonnet with a reasoning effort other than `medium` is untested.
- **The wire format is not a public contract.** reflex checks the request's shape at runtime and only fixtures for Claude Code 2.1.277 have been captured; a different version warns, a different major version runs `route` as `shadow`. A failed shape check turns the session back into `shadow`.
- **Restarts lose pins.** If the worker crashes it is restarted, but pins and open outcome windows live in its memory: a routed tool loop then continues on the requested model. A response that is already streaming when the worker dies fails (Claude Code retries it), and killing the reflex launcher itself ends the session's connection.
- **Route mode adds a wait.** A new turn waits for the backend decision, bounded by `REFLEX_JEV_DEADLINE_MS` (a setting), after which the request goes out unchanged. Every decision record splits the wait from the upstream's first byte.
- **Outcome capture is a record, not a verdict.** Correction scores are heuristics. One attribution case is known and open: an "undo" correction lands on the turn before the prompt that asked for it, while the revert it triggers is linked to the turn that made the edit.
- **Not verified on Windows or against a published package**; the [Phase 1 acceptance record](docs/acceptance-phase1.md) lists what was and was not exercised in real sessions.

## What we have measured

Each line is in [`docs/observations.md`](docs/observations.md) with its conditions. These are single sessions on one machine, not benchmarks.

- **Jev decision latency, fresh connection:** p50 823 ms, p95 1,136 ms (n = 12). One interactive shadow session, Claude Code 2.1.277 with Opus 5 requested, run from Turkey, Jev `jev-latest`, a new TCP+TLS connection per decision.
- **Jev decision latency, reused connection:** p50 382 ms, p95 408 ms (n = 11 decisions in three archived route sessions). Different days and prompts from the line above, so this is not a controlled comparison ([entry](docs/observations.md#2026-09-19--jev-latency-with-a-kept-alive-connection-archived-sessions-read-with-reflex-report)).
- **Classification, first dogfood session:** 61 requests, 12 of them starts of work, none unclassified, none degraded, no backend errors; `/compact` was classified as a side call.
- **Reasoning, not length.** One prompt in that session asked for a one-sentence answer to a hard question, and Jev picked Opus for it (reasoning demand 3.24 of 0–4). A 30-prompt labelled comparison of length-framed and reasoning-framed instructions is in `test/live/` (synthetic prompts, labels are the author's judgment, so at best indicative); its result is not recorded in `docs/observations.md` yet, so we do not state one.
- **Prompt cache cost of switching (route sessions A and B, Opus 5 requested).** Moving a conversation down wrote its whole context once on the target (63,689 tokens on Sonnet in one case). Moving up one tier from a cheaper pin wrote more (13,385 tokens) than returning to the requested model (5,924 tokens). This is why the guard exists and why `reflex report` shows cache writes by move type.

## Benchmarks

There are no benchmark or savings figures yet, on purpose. A measured cost report lands after a week of real use of v0.1.0 in route mode. It will come from this command on our own traffic, published with its sample sizes and conditions:

```sh
reflex report --since 7d --usd
```

You can run the same command on your own traffic today. It prices the same measured token counts at the model sent and at the model requested, at list prices, and says what it does not model (tokenizer differences, what the requested model's cache would have held, cache TTL, discounts, subscription limits). Until our numbers are published, treat any figure about savings, ours or anyone's, as unmeasured.

## Status

**v0.2.0-alpha: early, and measured numbers are pending.** Phase 2a added the workflow profile, side-call fingerprints and the opt-in delegation hint ([`CHANGELOG.md`](CHANGELOG.md)). Shadow and route modes, outcome capture, `reflex report` and `~/.reflex/env` work and are covered by tests that run offline (a guard fails any non-loopback connection); the live Jev tests and a final real session on this build are still to be run. Not published to npm. Release notes for what was and was not exercised: [`docs/acceptance-phase1.md`](docs/acceptance-phase1.md).

```sh
npm ci
npm test             # typecheck + lint + offline tests
npm run test:live    # needs a real TYPESAFE_API_KEY; skipped without one
npm run build
```

Notes on what Claude Code sends, with redacted captures: [`docs/wire-format.md`](docs/wire-format.md). Prior art: [`docs/prior-art.md`](docs/prior-art.md).

MIT. See [`LICENSE`](LICENSE) and [`THIRD_PARTY.md`](THIRD_PARTY.md).
