# reflex-router

An orchestration layer for [Claude Code](https://docs.claude.com/en/docs/claude-code). `reflex` starts a loopback proxy, runs the real `claude` behind it, and (as decision-making lands) uses a fast decision model to judge how much reasoning a piece of work demands, so that the cheapest adequate model handles it.

**Status: early development.** In `shadow` mode (the default) reflex forwards every request unchanged, classifies Claude Code's requests, asks the decision backend how much reasoning each new piece of work demands, and records what it *would* have routed where in `~/.reflex/decisions.jsonl`. In `route` mode (opt-in) it applies those decisions: a subagent's task, or a main-chat turn that passes the cost guard, can be sent to a cheaper model. Only retargets verified against the API are applied: Sonnet → Haiku, Opus → Sonnet and Opus → Haiku; every other would-be route (upgrades, Fable) is recorded and left alone. Nothing in this repository claims any cost or quality improvement; such claims will appear only with data measured by this project.

## Usage

```sh
npm install -g reflex-router     # requires Node.js 20+
export TYPESAFE_API_KEY=apikey_...   # decision backend key (not needed for `off`)
reflex                            # runs `claude`, everything after `reflex` is passed to it
reflex -p "explain this repo" --model sonnet
reflex doctor                     # what reflex would do with the current environment
reflex -- doctor                  # `--` forwards to claude even if the word is reserved
```

Everything you type after `reflex` goes to `claude` untouched, except the reserved subcommands `doctor`, `version` and `report` when they come first.

### Configuration

All settings are environment variables.

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
| `REFLEX_JEV_DEADLINE_MS` | integer, 50–60000 | `1500` | Hard deadline for one Jev decision, connection setup included. On expiry the request is forwarded unchanged (fail-open). Values below 50 ms are rejected as a configuration error. |
| `REFLEX_MAX_USER_CHARS`, `REFLEX_MAX_ASSISTANT_CHARS` | integer | `4000`, `1000` | How much text the decision backend may see. |

What is sent to the decision backend and what is stored locally is listed in [`docs/privacy.md`](docs/privacy.md).

### Route mode

- Only a positively identified start of work is decided: a user-typed main-chat prompt, or a subagent's first request. Its tool loop stays on the same model (a pin per conversation; per agent id for subagents). Harness side calls, notifications and anything unclassified are never touched.
- **Main chat** is only switched behind the cost guard: switching throws away the conversation's prompt cache, so a downgrade is allowed on a conversation's first turn (nothing cached yet) or when the measured one-time cache penalty is at most `REFLEX_MAX_SWITCH_PENALTY_USD`. Unknown context is refused. A refusal keeps the conversation on the model it is on now: a conversation already moved to a cheaper model stays there, is re-judged every turn, moves back up (never blocked) when the decision backend asks for more, and moves further down only through the guard. If the backend fails, the turn goes out unchanged on the requested model.
- **Overrides:** start a prompt with `reflex:haiku`, `reflex:sonnet` or `reflex:opus` to choose the tier for that turn and the subagents it spawns (recorded at each subagent's first request). It also works at the start of pasted text. `!`, `/`, `@` and `#` are not used because Claude Code consumes them (`!` is bash mode). The token stays in your prompt; reflex never edits prompt text.
- **Safety nets:** a decision that takes longer than `REFLEX_JEV_DEADLINE_MS` is dropped (request unchanged); a rewritten request the API rejects is re-sent with the original bytes and that tier is switched off for the session for 30 minutes; a failed runtime shape check turns the session back into shadow mode.
- Every routed record lists the requested model, the model actually sent, and the fields that were rewritten.
| `REFLEX_IGNORE_VERSION_CHECK` | `1` | unset | Do not degrade `route` to `shadow` on a Claude Code major-version mismatch (the warning stays). |

## How it stays out of the way

- **Fail-open.** An invalid configuration, a missing key, or any proxy problem never blocks `claude`: reflex runs plain `claude` or forwards requests straight to the upstream.
- **Supervised worker.** A small front door owns the loopback port for the whole session and forwards to a worker process. If the worker crashes it is restarted; if it hangs, a liveness probe kills it; if it keeps crashing, traffic goes straight to the upstream. The port is never unbound. Limitation: a request whose response is already streaming when the worker dies fails (Claude Code retries it), and killing the reflex launcher itself (`kill -9`) ends the session's connection.
- **Your credentials are untouched.** Authentication headers are forwarded as received and never read, stored or logged. `TYPESAFE_API_KEY` and all `REFLEX_*` variables are removed from the environment `claude` sees.
- **No edits to your Claude Code settings files.** reflex passes one temporary `--settings` file (merged with yours if you pass `--settings`) and deletes it on exit.
- **Loopback only.** The proxy binds to `127.0.0.1`.

### Claude Code version check

The wire format Claude Code speaks is not a public contract. reflex records which versions it has captured fixtures for. On start it compares your version: an exact match is silent, a different minor/patch version warns, and a different major version runs `route` as `shadow`. This is only a hint; decisions are additionally guarded by runtime shape checks.

## Development

```sh
npm ci
npm test             # typecheck + lint + offline tests (a guard blocks all non-loopback network access)
npm run test:live    # tests that need a real TYPESAFE_API_KEY (skipped without one)
npm run build
```

`docs/wire-format.md` records what was observed on the wire, with redacted fixtures in `test/fixtures/`. `docs/prior-art.md` summarises the projects this one learns from.

## License

MIT. See `LICENSE` and `THIRD_PARTY.md`.
