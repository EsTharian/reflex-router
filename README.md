# reflex-router

An orchestration layer for [Claude Code](https://docs.claude.com/en/docs/claude-code). `reflex` starts a loopback proxy, runs the real `claude` behind it, and (as decision-making lands) uses a fast decision model to judge how much reasoning a piece of work demands, so that the cheapest adequate model handles it.

**Status: early development.** The proxy forwards every request unchanged. In `shadow` mode (the default) it also classifies Claude Code's requests, asks the decision backend how much reasoning each new piece of work demands, and records what it *would* have routed where in `~/.reflex/decisions.jsonl`. It does not rewrite anything yet; `route` currently behaves like `shadow`. Nothing in this repository claims any cost or quality improvement; such claims will appear only with data measured by this project.

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
| `REFLEX_MAIN_CHAT` | `guarded`, `never` | `guarded` | Whether main-chat prompts are judged at all (subagent tasks always are). |
| `REFLEX_TIERS` | comma list of `haiku,sonnet,opus` | all three | Tiers a request may be routed to. Fable additionally needs `REFLEX_ALLOW_FABLE=1`. |
| `REFLEX_UPGRADES` | `off`, `confident`, `on` | `off` | Whether a stronger tier than requested may be chosen. |
| `REFLEX_MODEL_<TIER>` | model id | `ANTHROPIC_DEFAULT_<TIER>_MODEL`, else built in | Model id used for a tier. |
| `REFLEX_JEV_DEADLINE_MS` | integer | `1500` | Hard deadline for one Jev decision, connection setup included. On expiry the request is forwarded unchanged (fail-open). |
| `REFLEX_MAX_USER_CHARS`, `REFLEX_MAX_ASSISTANT_CHARS` | integer | `4000`, `1000` | How much text the decision backend may see. |

What is sent to the decision backend and what is stored locally is listed in [`docs/privacy.md`](docs/privacy.md).
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
