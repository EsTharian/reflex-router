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

When the worker starts in shadow or route mode it also sends one bare `HEAD /` to the TypeSafe host to open the connection early; it carries no key and no data.

Nothing else: no system prompt, tool list, file contents from tool results, session/agent/device/account ids, headers, paths as separate fields, or Anthropic credentials. The TypeSafe key travels only in the `Authorization` header to the TypeSafe endpoint.

Text is truncated first, then redacted (`src/privacy/redact.ts`): TypeSafe, Anthropic and other `sk-` keys, AWS access keys, GitHub/Slack/Google tokens, JWTs, PEM private keys, `Authorization`/`Bearer` values, the value of every `.env`-style `NAME=value` line, and home-directory prefixes (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>` become `~`). This is best effort, not a guarantee; entropy-based detection is deliberately not attempted because false positives would corrupt the task text.

## Stored locally

`~/.reflex/` (`REFLEX_HOME`): directory `0700`, files `0600`, rotated at 10 MB × 5.

`decisions.jsonl` holds one record per classified `POST /v1/messages` request: classification, signals, mode, the backend's answers and the would-be plan, upstream status, token usage, and error categories. Session ids are stored hashed (SHA-256, truncated); conversation keys are hashes. For decided requests it also stores `prompt_preview`: the redacted task, whitespace-collapsed, capped at 300 characters by a constant in the logger. `REFLEX_LOG_PROMPTS=0` omits it.

Never stored: request or response bodies, credentials, backend error bodies.

## Hook events (outcome capture)

In `shadow` and `route` mode reflex registers Claude Code `http` hooks (`UserPromptSubmit`, `PostToolUse` and `PostToolUseFailure` for Edit/Write/MultiEdit/NotebookEdit/Bash only, `SubagentStart`, `SubagentStop`, `Stop`) in its per-invocation `--settings` file. They go to the loopback front door, which answers `204` at once. Their payloads contain prompts, commands, file paths and edited text; these stay in the worker's memory for a few turns (to compare the next prompt and to detect reverted edits, using hashes of the edited text) and are never written or sent anywhere. What is written to `decisions.jsonl` (`record: "outcome"`, `"outcome_update"`, `"harness_injected"`): hashed session, prompt and agent ids, hashed file paths, counts, the matched correction rule ids and their score, test-runner kinds (e.g. `npm-test`) with exit codes, and revert kinds. No prompt text, commands, paths or code.

## Sent to Anthropic

The client's request with its own headers. The one header reflex changes is `accept-encoding`, narrowed to the codings it can decode (`gzip`, `br`, `deflate`). In `shadow` mode the body is sent byte for byte. In `route` mode a routed request's body is rewritten for the target model (model id, reasoning settings, `role:"system"` messages folded into user messages; `src/wire/rewrite.ts`) and the changed fields are listed in its decision record. No text is added, removed or edited; system-message text is only moved into the adjacent user message. No `REFLEX_*` or `TYPESAFE_*` value ever reaches the upstream.
