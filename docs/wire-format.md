# Claude Code wire format — observed facts

Everything here was **observed**, not inferred from documentation or prior art. Source: captures of Claude Code **2.1.277** on macOS, non-interactive (`claude -p`, `cc_entrypoint=sdk-cli`) and interactive (TUI, `cc_entrypoint=cli`), through `scripts/spike/capture.mjs` (a dump-only passthrough proxy). Redacted fixtures: `test/fixtures/claude-code/2.1.277/` (see its `manifest.json`). Raw dumps are gitignored under `_dumps/`.

This format is **not a public contract**. When Claude Code updates, re-run the capture (`docs/wire-format.md` §8) and diff.

## 1. What was captured

| Run | Setup | Requests | Cost |
| --- | --- | --- | --- |
| 1 | `--model sonnet`; main chat spawns one `general-purpose` subagent (Glob), then a failing Bash (`exit 1`), an Edit, a passing Bash; `--settings` with http hooks; a project-level command hook in `.claude/settings.json` | 9 | $0.32 |
| 2 | `--model haiku`; two `--settings` flags (ours + a user command hook) | 2 | $0.09 |
| 3 | `--model haiku`; local stdio MCP server declaring a JSON Schema **draft-04** tool | 2 | $0.07 |
| interactive | TUI session (`cc_entrypoint=cli`, Sonnet 5): a prompt that spawns a **background** Explore subagent, further prompts, `/compact`, a message from another session, a system notification | 30 + HEAD | not recorded |

Not captured (gaps, also listed in the manifest): forks, several concurrent subagents, custom `.claude/agents/*.md` subagents, an `Agent` call with an explicit `model`, `/resume`, Linux/Windows. To capture an interactive session yourself: `node scripts/spike/capture.mjs` (starts `claude` with the proxy and hooks), use it, then `node scripts/spike/redact-fixtures.mjs _dumps/<dir> --label <name>`.

## 2. Requests

- `POST /v1/messages?beta=true`, `stream: true`. Also once per process: **`HEAD /api/hello`** (not `HEAD /`); upstream answers 200. The two prior-art repos describe `HEAD /`.
- Body keys: `model, messages, system, tools, metadata, max_tokens, thinking, context_management, output_config, stream`.
- `metadata.user_id` is a **JSON string** `{"device_id":…,"account_uuid":…,"session_id":…}`. The device and account ids are personal identifiers → never log or send them.
- `system` is an array of 3 text blocks. Block 0 is the billing line: `x-anthropic-billing-header: cc_version=2.1.277.<3hex>; cc_entrypoint=sdk-cli;` (+ ` cc_is_subagent=true;` for subagents). The 3-hex suffix of `cc_version` differs between main and subagent requests of the same session. Block 1: `You are a Claude agent, built on Anthropic's Claude Agent SDK.`
- `messages`: the first user message holds `<system-reminder>` text blocks followed by the real prompt text. Sonnet requests carry `role:"system"` messages (mid-conversation-system beta), but **where** differs by entrypoint: with `sdk-cli` one trails the list and more accumulate as the tool loop grows (1, 1, 2, 2, 3, 4, 5, 6 over the run-1 requests); with `cli` they sit **mid-list** (index 1 in the main chat, 1 and 4 in the subagent, 3 after `/compact`) and do not accumulate. The native Haiku request had none (§5). Any "last message" logic must skip `role:"system"` messages wherever they are, and a rewrite that folds them must handle mid-list positions.
- Interactive-only differences: `thinking: {"type":"adaptive"}` **without** `display`; an extra `redact-thinking-2026-02-12` beta; 55 tools on the main chat and 34 on the Explore subagent (vs 45/43 with `sdk-cli`); the client sends `accept-encoding: gzip, deflate, br, zstd`.
- `thinking: {"type":"adaptive","display":"omitted"}`, `output_config: {"effort":"medium"}`, `max_tokens: 64000`, `context_management: {"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}` on Sonnet 5.
- 3–4 `cache_control` markers per request.
- Tools: 43–45 per request; the set differs between main (45) and subagent (43: no `ScheduleWakeup`, `Workflow`).

### Headers
Beyond standard ones: **`x-claude-code-session-id`** (on every request; equals `metadata.user_id.session_id` and the hooks' `session_id`), **`x-claude-code-agent-id`** (on subagent requests **only**; equals the hooks' `agent_id`, 17 chars, constant across that subagent's requests), `x-app: cli`, `user-agent: claude-cli/2.1.277 (external, sdk-cli)`, `x-stainless-*`, `anthropic-beta` (comma list), `anthropic-dangerous-direct-browser-access`.

`anthropic-beta` on Sonnet main: `claude-code-20250219, oauth-2025-04-20, interleaved-thinking-2025-05-14, thinking-token-count-2026-05-13, context-management-2025-06-27, prompt-caching-scope-2026-01-05, mid-conversation-system-2026-04-07, advisor-tool-2026-03-01, effort-2025-11-24, extended-cache-ttl-2025-04-11`. Subagent requests **lack `extended-cache-ttl-2025-04-11`** → main chat writes 1-hour cache entries, subagents 5-minute ones (matters for the cost guard).

## 3. Main vs subagent

| Signal | Main | Subagent |
| --- | --- | --- |
| `x-claude-code-agent-id` header | absent | present, == hook `agent_id` |
| `cc_is_subagent=true` in billing line | absent | present |
| `You are an agent for Claude Code` in system | absent | present on the `general-purpose` agent (sdk-cli); **absent** on the interactive Explore agent. Optional: never required, logged when seen |
| `x-anthropic-billing-header:` in system | present | present |
| subagent's first user text | — | **exactly equals** the parent's `Agent` tool `tool_input.prompt` |
| model | requested model | inherited (`Agent` input had no `model`; got `claude-sonnet-5`) |

The header and `cc_is_subagent=true` co-occurred on every subagent request (both entrypoints) and on no main-chat request. The agent-prompt marker is agent-type specific. A **background** subagent's requests interleave with main-chat requests, and its `SubagentStop` hook can arrive during a later user turn.

**Detection priority (our rule).** The header `x-claude-code-agent-id` is the **primary** signal (cheapest, no body parsing, and the exact join key to hooks). The two system-prompt markers are the **fallback** for when the header is absent. Every decision logs which signal fired (`signal: "header" | "marker:cc_is_subagent" | "marker:agent_prompt" | "none"`) and the raw presence of all three (`signals: {header, s1, s2}`), so a signal that starts disappearing shows up in the data before it causes damage. Header and markers disagreeing is itself a shape violation (§10).

## 4. Turns

Only **positively identified** work is ever decided on. `src/wire/claude-code.ts` classifies the last non-system message:

| Turn | Rule |
| --- | --- |
| `new` | `user` role, content is an **array** of text blocks whose text, after dropping reminder blocks and `<local-command-…>`/`<command-…>` wrappers, is non-empty, and no side marker (below). A subagent is `new` only on its first request |
| `continuation` | `user` role with `tool_result` blocks and nothing else except reminder blocks. Failed Bash arrives as `tool_result` with **`is_error: true`, content `"Exit code 1"`** |
| `side` | everything else, tagged with a `side_kind` |

Every user-typed prompt observed (both entrypoints) and every subagent start arrived as an array of blocks; every plain-string content was a harness side call.

### 4.1 Harness side calls (interactive)

These carry the full tool list and the same `messages[0]` as the real conversation, so they look like turns and share its conversation key. They are matched **only against the last message**, because the injected text stays in the history.

| `side_kind` | Last message | Fixture |
| --- | --- | --- |
| `suggestion` | plain string `[SUGGESTION MODE: …` | `interactive.main-suggestion` |
| `agent_summary` | plain string `Describe your most recent action…`, sent under the subagent's agent id | `interactive.subagent-summary` |
| `compaction` | `tool_result` + text `CRITICAL: Respond with TEXT ONLY…`; **lacks the `extended-cache-ttl` beta** | `interactive.main-compaction` |
| `cross_session` | text `Another Claude session sent a message:` (no `UserPromptSubmit` hook) | `interactive.main-cross-session` |
| `notification` | reminder-only, `[SYSTEM NOTIFICATION - NOT USER INPUT]` (no `UserPromptSubmit`) | `interactive.main-notification` |
| `no_tools` | no or empty `tools`: title generation (`output_config.format` JSON schema), `max_tokens: 64` side calls, the `max_tokens: 1` quota probe (no system prompt at all) | `interactive.title-generation`, `…side-no-tools`, `…quota-probe` |
| `unclassified` | anything else not positively identified | — |

Consequences: main-chat model turns are **not** 1:1 with `UserPromptSubmit`; `SubagentStop` also fires for agent ids that never had a `SubagentStart` and never appear as an `x-claude-code-agent-id` header (likely the suggestion forks).

## 5. Native Haiku request shape (Claude Code choosing Haiku itself)

| Field | Sonnet 5 (main) | Haiku 4.5 (main, native) |
| --- | --- | --- |
| `model` | `claude-sonnet-5` | `claude-haiku-4-5-20251001` |
| `thinking` | `{type:"adaptive", display:"omitted"}` | `{type:"enabled", budget_tokens:31999, display:"omitted"}` |
| `output_config` | `{effort:"medium"}` | **absent** |
| `max_tokens` | 64000 | 32000 |
| `context_management` | clear_thinking edit | **same** clear_thinking edit (kept) |
| trailing `role:"system"` message | yes | **no** |
| betas | as above | minus `effort-2025-11-24`, minus `mid-conversation-system-2026-04-07` |

This contradicts the prior-art recipe ("delete `thinking`, delete `context_management`"). What the API actually requires was then measured (§5.1).

### 5.1 Retargeting a Sonnet request to Haiku: what the API accepts (experiment)

`scripts/spike/rewrite-experiment.mjs` re-sent one real Sonnet 5 request (first turn of a fresh `claude -p` conversation) as 11 variants of a 6-step rewrite, using the live request's own auth headers held in memory only. Result file: `test/fixtures/claude-code/2.1.277/experiment.sonnet-to-haiku-retarget.results.json`.

| Rewrite step | Needed? | Evidence |
| --- | --- | --- |
| `model` → `claude-haiku-4-5-20251001` | yes | — |
| remove `output_config.effort` | **yes** | kept → 400 `This model does not support the effort parameter.` |
| `thinking` `adaptive` → `{type:"enabled", budget_tokens:31999}` | **yes** | kept → 400 `adaptive thinking is not supported on this model` |
| fold `role:"system"` messages into the adjacent user message | **yes** | kept → 400 `role 'system' is not supported on this model` |
| cap `max_tokens` at 32000 | **no** | accepted with 64000 |
| remove `effort-*` and `mid-conversation-system-*` betas | **no** | accepted with them present |
| `context_management` | keep as is | native Haiku keeps it; never removed |

The minimal working rewrite is therefore three field edits plus the model swap; the extra steps in a native Haiku request are not required, and fewer edits mean less risk. The API reports one validation error at a time, so necessity was established by leave-one-out, not from the messages alone.

**Scope.** One request, first turn, no assistant history. **Not tested:** switching the model in the middle of a conversation (Sonnet-generated `thinking` blocks with signatures already in `messages`), requests with earlier `tool_use`/`tool_result` turns, Opus/Fable targets, the `context-1m` beta, and subagent (5-minute cache) requests. A mid-conversation switch is the likeliest place for a rejection, which is one more reason the main chat is only switched behind a cost guard and every rewrite keeps the retry-with-original safety net.

Model ids observed: `claude-sonnet-5`, `claude-haiku-4-5-20251001`.

## 6. Responses

Plain SSE, `\n\n`-separated (no `\r\n` seen), events `message_start, content_block_start, ping, content_block_delta, content_block_stop, message_delta, message_stop`. The capture proxy drops `accept-encoding`, so compression was **not** observed. The interactive client offers `zstd`, which `node:zlib` cannot decode before Node 22.15, so reflex narrows `accept-encoding` toward the upstream to the client's own offer restricted to `gzip, br, deflate` (absent stays absent). A response in any other coding is relayed untouched and logged as `usage_unknown_reason: "encoding:<name>"`. `message_start.message.usage` has `input_tokens, cache_creation_input_tokens, cache_read_input_tokens, cache_creation{…}, output_tokens, service_tier, inference_geo`; final usage is in `message_delta.usage` (adds `output_tokens_details`, `iterations[]`).

## 7. Hooks (delivered via `type:"http"` hooks injected with `--settings`)

- Delivery works; 204 empty-body responses are accepted silently.
- `session_id` == wire session id (**verified**). `prompt_id` present on every event; `UserPromptSubmit` carries `prompt`.
- Inside a subagent every tool event carries `agent_id` + `agent_type` (`"general-purpose"`).
- `SubagentStart`: `{session_id, transcript_path, cwd, prompt_id, agent_id, agent_type}` — **no `tool_use_id`, no prompt**. `SubagentStop` adds `permission_mode, effort, stop_hook_active, agent_transcript_path, last_assistant_message, background_tasks, session_crons` — **no `outcome` field**.
- **A failing Bash fires `PostToolUseFailure` only** (`error: "Exit code 1"`, `is_interrupt: false`); a passing one fires `PostToolUse` with `tool_response = {stdout, stderr, interrupted, isImage, noOutputExpected}`.
- Edit: `tool_input = {file_path, old_string, new_string, replace_all}`; `tool_response` includes `filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll`.
- Join keys: hook `agent_id` == request `x-claude-code-agent-id` → **exact attribution**, no FIFO needed.

### `--settings` semantics
- Hooks from **different sources merge**: project `.claude/settings.json` command hooks and `--settings` http hooks both fired for the same events (5 tool events each, including the subagent's Glob).
- **Multiple `--settings` flags do not merge — the last wins wholesale.** With two flags, our hooks (first flag) never fired; the second flag's hook did. `ANTHROPIC_BASE_URL` still took effect via the process environment. Consequence: a user-supplied `--settings` must be merged into ours (or ours skipped), never added alongside.

## 8. Things that did NOT reproduce

- **MCP draft-04 normalisation** (jev-router): verified only **in scope**. The fixture `haiku-mcp-draft4.main-new-turn.request.json` contains the construct (`$schema` draft-04, `minimum:0 + exclusiveMinimum:true`, `maximum:10 + exclusiveMaximum:false`), Claude Code sent it **unchanged** through a custom base URL, and the API returned **200** (one request, `claude-haiku-4-5-20251001`, `sdk-cli`). Not tested: Sonnet/Opus/Fable as the target, other draft-04 constructs (`id`, `definitions`, type arrays), the interactive entrypoint. So the compat rewrite is *not currently required*, which is weaker than *not needed*; if routing ever retargets a request to a model that rejects the schema, the 4xx retry-with-original path is the safety net. Recorded in `manifest.json` under `findings`.
- `HEAD /` (prior art) — actually `HEAD /api/hello`.

## 9. Re-capturing for a new Claude Code version

```
node scripts/spike/capture.mjs --out _dumps/<name> -- -p "<prompt>" --output-format json …
node scripts/spike/summarize.mjs _dumps/<name>
REFLEX_REDACT_EXTRA="<email>,<username>" node scripts/spike/redact-fixtures.mjs _dumps/<name> --label <name>
```
`redact-fixtures.mjs` masks identifiers everywhere they occur, elides long prompt text while preserving the detection markers (and asserts they survive), and fails if any original identifier or common secret shape remains. Fixtures land in `test/fixtures/claude-code/<version>/` with a `manifest.json`; the startup version check (plan §3.1) compares the running `claude --version` with those directories.

## 10. Expected shape (checked at runtime)

The startup version check is only a hint. The worker therefore verifies the shape itself on the first N (default 10, `REFLEX_SHAPE_CHECK_N`) `new`/`continuation` requests of a session; side calls are never checked (they legitimately differ). Any violation degrades the session to shadow and logs `degraded_reason: "shape:<check>"` with the signal booleans (never request content). All expectations below hold for every fixture (`test/unit/wire-contract.test.ts`), and each mutated fixture trips exactly its check (`test/unit/wire.test.ts`):

| Check | Expected |
| --- | --- |
| `session_id` | `x-claude-code-session-id` present, or `metadata.user_id` parses to JSON with `session_id`; when both exist they are equal |
| `client_identity` | system text contains `x-anthropic-billing-header:` |
| `subagent_signals` | header `x-claude-code-agent-id` present ⇔ `cc_is_subagent=true` present; the optional agent-prompt marker, when seen, only on a subagent |
| `system_messages_beta` | `role:"system"` messages present ⇒ the `mid-conversation-system-*` beta is present (one-way: side calls carry the beta without system messages) |
| `turn_structure` | at least one non-system message, and the last one has `role:"user"` |

Dropped after the interactive capture: "main-chat requests carry `extended-cache-ttl-*`" (the compaction request lacks it, which would have degraded normal sessions).

The version check is separate and only ever a hint: same major, different minor/patch → warn; different major → degrade to shadow; unparseable → warn. Passing assertions on an unknown minor version continue normally; failing assertions on a matching version still degrade.
