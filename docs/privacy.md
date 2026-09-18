# Privacy: what reflex sends and stores

## Sent to the decision backend (TypeSafe Jev)

Only for a request positively identified as the start of work (a user-typed main-chat prompt, or a subagent's first request; see `docs/wire-format.md` §4). Tool-loop steps, harness side calls and anything unclassified are never sent.

The request body is `{ state, model, questions }`. `questions` is fixed text from `src/policy.ts`. `state` has exactly these keys (asserted by `test/unit/privacy.test.ts` and `test/integration/shadow.test.ts`):

| Key | Content | Limit |
| --- | --- | --- |
| `task` | the user's prompt (or the subagent's delegation prompt), with harness reminders and local-command wrappers removed | `REFLEX_MAX_USER_CHARS` (default 4000), head + tail |
| `previous_assistant_reply` | main chat only: text of the assistant message just before the prompt | `REFLEX_MAX_ASSISTANT_CHARS` (default 1000), tail |
| `context.requesting_tier` | `haiku` / `sonnet` / `opus` / `fable` / `unknown`, derived from the requested model id | — |
| `context.is_subagent` | boolean | — |

Nothing else: no system prompt, tool list, file contents from tool results, session/agent/device/account ids, headers, paths as separate fields, or Anthropic credentials. The TypeSafe key travels only in the `Authorization` header to the TypeSafe endpoint.

Text is truncated first, then redacted (`src/privacy/redact.ts`): TypeSafe, Anthropic and other `sk-` keys, AWS access keys, GitHub/Slack/Google tokens, JWTs, PEM private keys, `Authorization`/`Bearer` values, the value of every `.env`-style `NAME=value` line, and home-directory prefixes (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>` become `~`). This is best effort, not a guarantee; entropy-based detection is deliberately not attempted because false positives would corrupt the task text.

## Stored locally

`~/.reflex/` (`REFLEX_HOME`): directory `0700`, files `0600`, rotated at 10 MB × 5.

`decisions.jsonl` holds one record per classified `POST /v1/messages` request: classification, signals, mode, the backend's answers and the would-be plan, upstream status, token usage, and error categories. Session ids are stored hashed (SHA-256, truncated); conversation keys are hashes. For decided requests it also stores `prompt_preview`: the redacted task, whitespace-collapsed, capped at 300 characters by a constant in the logger. `REFLEX_LOG_PROMPTS=0` omits it.

Never stored: request or response bodies, credentials, backend error bodies.

## Sent to Anthropic

The client's request, byte for byte, with its own headers. The one header reflex changes is `accept-encoding`, narrowed to the codings it can decode (`gzip`, `br`, `deflate`). No `REFLEX_*` or `TYPESAFE_*` value ever reaches the upstream.
