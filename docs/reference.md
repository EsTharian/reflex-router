# Reference: configuration, route mode, safety nets

Details behind the [README](../README.md). Nothing here is a performance claim; where a default comes from a measurement it points at [`observations.md`](observations.md).

## Configuration

Settings are environment variables, optionally supplied by `~/.reflex/env`. A variable that is set to an empty or whitespace-only value (`export ANTHROPIC_BASE_URL=""`) counts as unset, so the next source or the default applies. Defaults below are provisional settings, not measured optima; where one is derived from a measurement its row says so and points at [`docs/observations.md`](observations.md).

**`~/.reflex/env`** (in `REFLEX_HOME` if that is set in the environment) holds `KEY=value` lines for `REFLEX_*` settings and `TYPESAFE_API_KEY`; `#` comments, `export ` and quotes around a value are accepted, other names are ignored with a warning. It is merged **under** the process environment: a variable already set in the environment (and not empty) wins. `REFLEX_HOME` cannot be set in the file, since it says where the file is. A file that contains `TYPESAFE_API_KEY` and is readable by group or others (`chmod 600` fixes it; not checked on Windows) is refused whole: reflex warns, ignores every value in it, and runs without the key, i.e. as plain `claude`. A file it cannot read is skipped with a warning. `reflex doctor` shows the file's state, why a file was refused, and for every setting that is set whether its value came from the process environment or the file; it never prints the key.

| Variable | Values | Default | Meaning |
| --- | --- | --- | --- |
| `REFLEX_MODE` | `route`, `shadow`, `off` | `shadow` | `off` runs plain `claude` with no proxy at all. `shadow` and `route` run the proxy. |
| `REFLEX_BACKEND` | `jev`, `local` | `jev` | Decision backend. `local` is a placeholder and currently runs plain `claude`. |
| `TYPESAFE_API_KEY` | `apikey_...` | unset | Key for the Jev backend. Without it reflex runs plain `claude` and says so. |
| `REFLEX_UPSTREAM_URL` | http(s) URL | your `ANTHROPIC_BASE_URL`, else `https://api.anthropic.com` | Where requests are forwarded. A path prefix (gateway) is kept. |
| `REFLEX_CLAUDE_BIN` | path or command | `claude` on `PATH` | The real Claude Code binary. |
| `REFLEX_HOME` | directory | `~/.reflex` | State directory (worker log, `decisions.jsonl`). |
| `REFLEX_LOG_PROMPTS` | `0` | on | `0` omits the redacted 300-character prompt preview from the decision log. |
| `REFLEX_MAIN_CHAT` | `guarded`, `never` | `guarded` | Whether main-chat prompts are judged at all (subagent tasks always are). `guarded`: a main-chat switch must pass the cost guard. |
| `REFLEX_MAX_SWITCH_PENALTY_USD` | number | `0.01` | Cost guard: the most a main-chat model switch may cost in lost prompt cache (list prices, `src/pricing.ts`). |
| `REFLEX_TIERS` | comma list of `haiku,sonnet,opus` | all three | Tiers a request may be routed to. Fable additionally needs `REFLEX_ALLOW_FABLE=1`. |
| `REFLEX_DECISION_RULE` | `mass`, `argmax` | `mass` | How the tier is read from the decision backend's probabilities. `mass`: the cheapest tier that leaves at most `REFLEX_MASS_EPS` probability on the tiers above it. `argmax`: the backend's top choice, and a downgrade needs choice confidence ≥ 0.70. Both readings are logged either way. |
| `REFLEX_MASS_EPS` | 0–0.5 | `0.10` | Probability the `mass` rule may leave on more expensive tiers. |
| `REFLEX_UPGRADES` | `off`, `confident`, `on` | `off` | Whether a stronger tier than requested may be chosen. |
| `REFLEX_MODEL_<TIER>` | model id | `ANTHROPIC_DEFAULT_<TIER>_MODEL`, else built in | Model id used for a tier. |
| `REFLEX_JEV_DEADLINE_MS` | integer, 50–60000 | `1500` | Hard deadline for one Jev decision, connection setup included. On expiry the request is forwarded unchanged (fail-open). Values below 50 ms are rejected as a configuration error. The default was set above the p95 of the first dogfood session (1,136 ms, n = 12, a new connection per decision; see the first entry of [`observations.md`](observations.md)). |
| `REFLEX_MAX_USER_CHARS`, `REFLEX_MAX_ASSISTANT_CHARS` | integer | `4000`, `1000` | How much text the decision backend may see. |
| `REFLEX_IGNORE_VERSION_CHECK` | `1` | unset | Do not degrade `route` to `shadow` on a Claude Code major-version mismatch (the warning stays). |
| `REFLEX_DELEGATE` | `1` | unset | Experiment: add the fixed delegation hint (`src/delegate/hint.ts`) to every prompt you type, through the `UserPromptSubmit` hook (`shadow` and `route` mode only). Can raise total spend; see the README. |

What is sent to the decision backend and what is stored locally is listed in [`docs/privacy.md`](privacy.md). In short: the decision log holds no secrets and no home-directory paths, and no user text beyond a redacted preview of at most 300 characters of each decided prompt (project-relative paths in it are not removed). The preview is **on by default** so that decisions can be reviewed and tuned; that default will be revisited before a public release. `REFLEX_LOG_PROMPTS=0` removes it.

## Route mode

- Only a positively identified start of work is decided: a user-typed main-chat prompt, or a subagent's first request. Its tool loop stays on the same model (a pin per conversation; per agent id for subagents). Harness side calls, notifications and anything unclassified are never touched.
- **Main chat** is only switched behind the cost guard: switching throws away the conversation's prompt cache, so a downgrade is allowed on a conversation's first turn (nothing cached yet) or when the measured one-time cache penalty is at most `REFLEX_MAX_SWITCH_PENALTY_USD`. Unknown context is refused. A refusal keeps the conversation on the model it is on now: a conversation already moved to a cheaper model stays there, is re-judged every turn, moves back up (never blocked) when the decision backend asks for more, and moves further down only through the guard. If the backend fails (error, timeout, open breaker), a conversation already on a cheaper model stays there (`stay_pinned_backend_error`; leave with `reflex:opus`); otherwise the turn goes out unchanged on the requested model.
- **Overrides:** start a prompt with `reflex:haiku`, `reflex:sonnet` or `reflex:opus` to choose the tier for that turn and the subagents it spawns (recorded at each subagent's first request). It also works at the start of pasted text. `!`, `/`, `@` and `#` are not used because Claude Code consumes them (`!` is bash mode). An override skips the decision backend, the confidence rule and the main-chat cost guard: it is your explicit choice, so a main-chat override can pay the cache penalty the guard would have refused. The token stays in your prompt; reflex never edits prompt text.
- **Caveats.** Route mode rewrites requests, and only pairs verified against the API are rewritten (see [README](../README.md#how-it-works)). Harness side calls (prompt suggestions and the like) are never rewritten and keep billing the requested model, so part of a routed session's usage stays on that model by construction. Moving a conversation down costs one cache write of its whole context on the target model, which is why main chat sits behind the guard (measured in [`observations.md`](observations.md), route sessions A and B). Upgrades above the requested model and Fable retargets are not applied. Whether routing changes the quality of the work is not measured; the outcome records (below) exist to collect that evidence, not to prove it.
- **Safety nets:** a decision that takes longer than `REFLEX_JEV_DEADLINE_MS` is dropped (request unchanged); a rewritten request the API rejects is re-sent with the original bytes and that tier is switched off for the session for 30 minutes; a failed runtime shape check turns the session back into shadow mode.
- Every routed record lists the requested model, the model actually sent, and the fields that were rewritten.

## How it stays out of the way

- **Fail-open.** An invalid configuration, a missing key, or any proxy problem never blocks `claude`: reflex runs plain `claude` or forwards requests straight to the upstream.
- **Supervised worker.** A small front door owns the loopback port for the whole session and forwards to a worker process. If the worker crashes it is restarted; if it hangs, a liveness probe kills it; if it keeps crashing, traffic goes straight to the upstream. The port is never unbound. Limitation: a request whose response is already streaming when the worker dies fails (Claude Code retries it), and killing the reflex launcher itself (`kill -9`) ends the session's connection.
- **Your credentials are untouched.** Authentication headers are forwarded as received and never read, stored or logged. `TYPESAFE_API_KEY` and all `REFLEX_*` variables are removed from the environment `claude` sees.
- **No edits to your Claude Code settings files.** reflex passes one temporary `--settings` file (merged with yours if you pass `--settings`) and deletes it on exit.
- **Loopback only.** The proxy binds to `127.0.0.1`.

## Outcome capture (record only)

In `shadow` and `route` mode reflex also registers Claude Code hooks for the session (in the same temporary `--settings` file; your settings files are not edited) and records, per decided turn, signals for later tuning: how much the next prompt reads like a correction (a score and the matched rule ids, not a verdict), a failing test run after an edit in the turn, and edits undone within three turns (inverse edit, file restored, `git checkout`/`restore`/`reset --hard`). Records go to `decisions.jsonl` next to the decision they belong to (`record: "outcome"`). Nothing is escalated or changed because of them. A turn the proxy saw without a matching `UserPromptSubmit` is recorded as `harness_injected`; an outcome window without a proxy decision (Claude Code also fires `UserPromptSubmit` for messages it injects itself) says why in `no_decision`. Slash commands (`/…`) open no window. What these records contain is listed in [`docs/privacy.md`](privacy.md).

The hooks are answered with no output, with one opt-in exception: with `REFLEX_DELEGATE=1` a `UserPromptSubmit` for a prompt you typed (not a slash command, an injected message or a subagent's hand-back, not inside a subagent) is answered with `hookSpecificOutput.additionalContext` holding the delegation hint, and a `record: "delegate_hint"` (hashed session, hint version) is written. The answer never carries a decision or anything that can block or change the prompt; when the worker is down the front door answers `204` itself.

## Claude Code version check

The wire format Claude Code speaks is not a public contract. reflex records which versions it has captured fixtures for. On start it compares your version: an exact match is silent, a different minor/patch version warns, and a different major version runs `route` as `shadow`. This is only a hint; decisions are additionally guarded by runtime shape checks.

## `reflex report` in detail

```sh
reflex report [--since 2h] [--usd | --fingerprints] [<decisions.jsonl> ...]
```

Reads `~/.reflex/decisions.jsonl` and its rotations (or the files you name), makes no network request, and prints its sections (a last line without a newline, that is a record the worker is still writing, is skipped and counted in the header, and the next report has it). First a **workflow profile** (section 0): user turns per session; the share of tokens in main-chat new turns, tool-loop continuations, subagents and side calls; a split by delegation hint version with total tokens, dollars at list prices and both per user turn; and the verdict "routing can touch at most X% of your tokens; Y% of that is in subagents", where a new turn and the continuations of its conversation count as touchable when the plan put the turn below the requested tier (ignoring the cost guard) or it was routed there. Then: decisions by kind, turn and tier; `mass` vs `argmax` (agreement and what each rule would have routed); shadow vs actual (would-route tier by requested tier, with the share of tokens each cell carries; requested vs sent model); guard refusals; fallbacks and the breaker; latency (Jev by new vs reused connection, and time to response headers for routed vs unrouted turns, split into the wait for the decision and the upstream's first byte, with timed-out decisions checked against the deadline); outcome rates for routed vs unchanged turns, always with sample sizes and an explicit "insufficient data" line below 20 windows; cost at list prices; side-call usage on its own line; cache writes by move type (down, up short of the requested tier, back to the requested tier); and the structural fingerprints of unclassified side calls (section 11). `--fingerprints` prints only those fingerprints, grouped, as JSON lines, for sending back so the calls can be given a side kind; they hold no user text (see [`docs/privacy.md`](privacy.md)).

The cost section is an **estimate**: the same measured token counts priced at the model sent and at the model requested, at the list prices in `src/pricing.ts` (last checked against Anthropic's pricing page on 2026-09-19). It does not model tokenizer differences between models, what the requested model's cache would have held, cache TTL, discounts or subscription limits, and its "requested" side overstates what staying would have cost (the report says why). By default it shows relative usage; `--usd` adds dollar columns. Side calls are never attributed to a routed model. Its last line compares sessions with and without the delegation hint (all requests, side calls included, per user turn, with the number of sessions on each side). It is a way to look at your own log, not a savings claim.
