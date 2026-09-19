# Prior art

Research for reflex-router Phase 1. Two existing projects were cloned into `_reference/` (gitignored) and read by subagents; a handful of load-bearing claims were then re-verified against the source by hand (marked ✔ verified).

| Project | Commit | Language | Notes |
| --- | --- | --- | --- |
| [`adarshmishra07/jcm-router`](https://github.com/adarshmishra07/jcm-router) | `083df7f` | TypeScript on **Bun** | Standalone proxy + supervisor + dashboard + eval. MIT. |
| [`gargpratyush/jev-router`](https://github.com/gargpratyush/jev-router) | `0d39e5b` | Plain ESM `.mjs`, Node | Wraps `claude`. Only dependency `@typesafe-ai/sdk`. MIT. |

*Update after Milestone 0:* several of these quirks were re-tested against Claude Code 2.1.277 — see `wire-format.md` and the notes marked *M0* below.

Both are single-commit repos. Line references below are per file at those commits. Where a README and the code disagree, the code is treated as the truth and the disagreement is noted — those are useful hints about what not to promise in our own README.

## 1. Jev API (from the TypeSafe docs, not from either repo)

Read directly from docs.typesafe.ai (`introduction`, `primitives/{choice,score,noul}`, `api`, `confidence`, `concepts/state`, `models`, SDK constants/retries).

- `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, `Content-Type: application/json`. Base URL override in the Python SDK: `TYPESAFE_BASE_URL`; key: `TYPESAFE_API_KEY`.
- Request: `{ "state": string | object | array, "model": "jev-latest", "questions": { <name>: Question } }`.
  - `choice`: `{type, instructions, criteria: {<option>: string | null | {what, not_for, examples}}}` — up to 255 options.
  - `score`: `{type, instructions, criteria: [2..10 ordered level descriptions]}`.
  - `noul`: `{type, instructions, criteria?: {true, false}}`.
  - `instructions` may also be an object/array ("advanced structure").
- Response: `{model, answers: {<name>: Answer}, usage: {input_tokens, output_tokens}}`.
  - choice → `{type, choice, probabilities, confidence}`; score → `{type, score, legend, probabilities?, confidence}`; noul → `{type, noul}` (0–1).
- Errors: 401, 422, 429, 529. The Python SDK retries 408/429/5xx twice, default timeout 10 s — **we will not retry**; our budget is a hard deadline (see plan).
- Limits/pricing: 64k tokens total (32k state + longest question), 1,200 req/min, input $0.042 per million tokens, output free. `jev-latest` currently = `jev-1.13.0`.
- **`confidence` is not the top probability.** It is a spread statistic. The quickstart example returns probabilities 0.84 / 0.159 / 0.001 with `confidence: 0.596`. The docs explicitly say to "start with conservative thresholds, test with your own data". Consequence: a `0.7` floor copied from jcm-router is not a probability. We log **both** `confidence` and the full `probabilities` so Phase 2 can tune on either.
- Latency: docs claim ~100–500 ms; jcm-router's README says "0.3 to 1 s" measured on every new turn, and jev-router budgets up to 3 s worst case. We treat latency as something we measure, not assume.

## 2. jcm-router

### Architecture
- Two-process design. `scripts/supervise.ts` spawns `src/index.ts` (the router, a single `Bun.serve` on 8787) and, via `scripts/up.ts`, a separate dashboard on 8788. State is passed to the router via env `ROUTER_SUPERVISION`.
- The user launches `claude` themselves with `ANTHROPIC_BASE_URL=http://localhost:8787`; alternatively `scripts/env-on.sh` writes `env.ANTHROPIC_BASE_URL` into `~/.claude/settings.json` (jq, timestamped backup, refuses if `/healthz` is down).
- Modules: `env.ts` (single env reader, returns config or error list), `conversation.ts` (turn classification), `decide.ts`, `routing-policy.ts` (questions, thresholds, guards), `cost.ts`, `jev.ts` (2.5 s timeout, never throws, strict response validation), `rewrite.ts`, `proxy.ts`, `usage.ts` (SSE tee), `decision-log.ts`.
- Request flow (`server.ts:79-148`): match `/v1/messages` by pathname → buffer body → `classifyRequest` → passthrough / continuation (reuse cached decision, no Jev) / new turn (`parseOverrides` → `skipBeforeAsking` → `askJev` → `decide` → `guardSwitch`) → rewrite only if the decision differs from what was requested, otherwise forward the original bytes → tee the response to parse usage → journal after the stream ends.
- **Retry-with-original**: if a rewritten request gets a 4xx other than 401/403/429, re-send the original body and headers; record `source: fallback`.
- **Supervisor + passthrough** (`scripts/supervise.ts`): respawn on non-zero exit with 200 ms→5 s backoff; ≥3 crashes in 60 s → the supervisor itself binds the port and forwards everything with no routing; every 60 s it tries to hand the port back to a fresh router that must survive 3 s. Known hole (admitted): the port is unbound for a few seconds on each retry.
- Dashboard: separate process re-reading `decisions.jsonl`; shows actual vs baseline cost, main vs subagent split, cache health, Jev p50/p95.
- Eval harness: 41 hand-labeled prompts; Jev-only; confusion matrix and confidence-of-hits-vs-misses.

### Routing policy
- Asks Jev three questions per new turn: `model` (choice: haiku/sonnet/opus/fable, each with `what`/`not_for`/`examples`, focus line "Judge difficulty and blast radius, not length of the message"), `effort` (choice: low…max), `is_followup` (noul). State sent: `latest_user_message` (≤6000 chars), `previous_assistant_reply` (≤2000), `previous_routing`.
- Thresholds: model/effort confidence ≥ 0.7; follow-up noul ≥ 0.55; upgrade confidence ≥ 0.8; main-chat context cap 100k tokens; haiku→sonnet above 150k tokens; max switch cost $0.25.
- Precedence: override tokens → follow-up (reuse previous decision) → confident Jev choice → requested model. Leading `!opus !high` tokens, scan stops at first non-override token.
- Cost guard (`cost.ts`): `stayCost = ctx × price[from] × 0.1`, `switchCost = ctx × price[to] × 2`, allow if the difference ≤ $0.25 (cache read multiplier 0.1, 1-hour cache write multiplier 2). Output tokens and fresh input ignored.
- **Upgrades off by default** (`ROUTER_UPGRADES=off`): their own measurement — "downgrades saved $22.67, upgrades cost $13.36 extra" over 427 requests.
- New turn vs continuation (`conversation.ts:62-84`): passthrough if no `tools`; last non-system message must be `user`; if it contains a `tool_result` block → continuation (reuse the decision of the most recent routed turn); else new turn. Prompt text ignores blocks starting `<system-reminder>`.
- Subagent detection (`conversation.ts:86-98`, ✔ verified): substring search of the system prompt for `cc_is_subagent=true` (in Claude Code's `x-anthropic-billing-header:` line) or `You are an agent for Claude Code`. No match but billing marker present → `main`; neither → `undefined` (other client, treated as main).
- Turn key = sha256(prompt + previous assistant text). **Not conversation-scoped.**

### Compatibility quirks handled
| Quirk | Where |
| --- | --- |
| Route on pathname only; Claude Code sends `/v1/messages?beta=true`; re-append `url.search` | `server.ts:157`, `proxy.ts:29` |
| `count_tokens` is not routed (exact path match) | `server.ts:157` |
| Drop `host`, `accept-encoding`, `content-length` on request; drop `content-encoding`, `content-length` on response (fetch already decompressed) | `proxy.ts:4-6,34` |
| All other headers forwarded verbatim (auth, `anthropic-beta`, `anthropic-version`, `x-app`) | `proxy.ts` |
| Strip `context-1m-*` from `anthropic-beta` when target is Haiku (400 otherwise); delete header if empty | `proxy.ts:14-25` |
| Preserve `thinking` (`{type:"adaptive",display:"omitted"}`) and other `output_config` keys (e.g. `format`) when setting `output_config.effort` | `rewrite.ts:40-64` |
| Haiku target: delete `output_config.effort` (and empty `output_config`), delete `thinking`, delete `context_management` if only `clear_thinking*` edits | `rewrite.ts:44-56` |
| Haiku rejects mid-conversation `role:"system"`: fold blocks into nearest user message, `tool_result` blocks stay first | `rewrite.ts:13-31` |
| Skip mid-conversation system messages and `<system-reminder>` text when finding the user prompt | `conversation.ts:30,66` |
| Turn key ignores `cache_control` and cleared tool results | `conversation.ts:55-56` |
| Requests without `tools` are passthrough (title generation, side calls) | `conversation.ts:63` |
| SSE tee for usage: split on `\n\n`, `TextDecoder` in stream mode, JSON body fallback, tee failure ⇒ usage null | `usage.ts:23-76` |
| `idleTimeout: 255` for long streams | `server.ts:152` |
| Unset `ANTHROPIC_API_KEY` at launch, otherwise Claude Code bills the API key not the subscription | README / launch command |
| Base URL must be http(s); `TYPESAFE_API_KEY` must start `apikey_` | `env.ts` |

### Stated limitations (quoted or near-quoted from README)
- "Routing subagents saves money, routing an established main chat loses it. Prompt caches are per model." Unguarded early version: $106.73 vs $87.19 baseline over 309 requests, $17.12 of the $19.53 loss from the main chat.
- Decisions live in memory and are lost on restart; an in-flight tool loop then passes through unchanged.
- First-turn context size is a guess (`chars / 2.8`, admitted to be off by up to ~4×).
- Haiku needs rewrites; "a few Claude Code features may still be rejected; those fall back".
- "New-turn detection follows the request shapes Claude Code 2.1.x sends."
- Supervisor does not cover `kill -9` on itself, reboot, or sleep.
- "Every new message waits 0.3 to 1 s on Jev" — their own advice is to use `ROUTER_SCOPE=subagents`.
- Jev cost is not tracked in the dashboard.

### Weaknesses found in the code (not in their README)
1. Turn key is not conversation-scoped → two sessions with a short repeated prompt ("yes") share a decision.
2. Listener binds all interfaces (`Bun.serve` with no `hostname`), including the passthrough and dashboard.
3. Supervisor detects exits only; a hung router is never noticed.
4. No upstream timeout, no abort propagation on client disconnect, whole body buffered.
5. Journal is append-only, never rotated, and keeps a 300-char prompt preview by default.
6. `eval/questions.json` and `scripts/cost.ts` prices are hand-copied duplicates ("keep in sync", not enforced).
7. Threshold 0.70 sits outside the range their own tuner supports (0.4–0.65); it rests on "four decisions".
8. README/code mismatches: "after a 4xx, keeps the original for the rest of the conversation" (code caches only that turn); "forks always routed" (a fork inherits the parent's system prompt and is labelled `main`); "overrides beat every gate" (the haiku 150k cap still applies).
9. Bun-only APIs (`Bun.serve`, `Bun.spawn`, `Bun.CryptoHasher`, `bun:test`) — needs a Node port.

## 3. jev-router

### Architecture
- One Node process: `bin/jev-claude.mjs` loads env files, starts an in-process HTTP proxy on `127.0.0.1:0` (✔ verified `proxy.mjs:342`), then spawns the real `claude` with `stdio: "inherit"` and args `argv.slice(2)` **plus** `--add-dir <repo>` and `--settings <tmp>` (for a status line). No daemon, no IPC.
- Child env: `ANTHROPIC_BASE_URL`, plus a "custom model picker" set (`ANTHROPIC_CUSTOM_MODEL_OPTION=jev-router`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`, `ANTHROPIC_MODEL=jev-router`). Routing is triggered by the sentinel model id `jev-router`; any other model is passed through.
- Exit: `child.on("exit")` → `process.exit(signal ? 1 : code ?? 0)`. No signal forwarding (SIGTERM to the wrapper orphans the child and skips cleanup).
- Auth: Claude Code's own `authorization`/`x-api-key` headers pass through untouched.
- If no Jev key: no proxy, `claude` is spawned bare with a warning.
- `src/policy.mjs` `decide()` is a pure function with a table-style test. `src/proxy.mjs` takes injectable `upstreamURL` and `route`, which makes end-to-end tests cheap.

### Routing policy
- Jev call via `@typesafe-ai/sdk`: state `{request, session:{current_model, context_tokens}, environment:{available_models}}`; questions = three `score` questions (task complexity, reasoning required, tool complexity — **display only, never used in the decision**) + one `choice` keyed by exact model id.
- Choice question (verbatim): "Pick the cheapest exact model that can fully complete this coding request in one pass, without retrying on a stronger model." + "Treat different model versions as separate choices. Judge required reasoning, not requested reply length." Options carry `what`/`signals`/`not_for` per tier plus catalog metadata (release date, context window).
- Policy order: regex override (`use|switch to|with|on opus|…`) → no Jev result ⇒ keep current → `confidence < 0.3` (downgrade blocked; upgrade capped at `max(current, sonnet)`) → downgrade with `contextTokens > 20000` blocked ("not worth cache rebuild") → Jev choice. Then `clampToAvailable` steps **up** to the nearest available tier, never into Fable unless `JEV_ALLOW_FABLE=1`.
- **The "reasoning demanded, not reply length" finding** (0.21 on Haiku → 0.81 on Opus for a hard prompt) is the user's description; in the repo it exists only as that one sentence in the question. There is no test, comment or doc backing it. We must reproduce it ourselves in `test:live`.
- Session id (✔ verified `proxy.mjs:136`): `JSON.parse(body.metadata.user_id).session_id`. State key = sha1(session + first message text) so that concurrent sub-conversations (subagents) get independent state; capped at 50 entries. There is no explicit subagent signal.
- New turn (`newTurnPrompt`, `proxy.mjs:55-72`): needs non-empty `tools`; last message role `user`; not a `tool_result`; text with `<system-reminder>…</system-reminder>` regions stripped.
- Pinning: `state.tier/model` set per fresh turn, reused for every `tool_result` continuation.

### Compatibility quirks handled
| Quirk | Where |
| --- | --- |
| **MCP draft-04 JSON Schema**: Claude Code skips its own schema conversion when `ANTHROPIC_BASE_URL` is set, so MCP tools with boolean `exclusiveMinimum/Maximum` (draft-04) get a 400. Rewrite: `exclusiveMinimum:true` + numeric `minimum` → `exclusiveMinimum: <min>` and delete `minimum`; `false` (or `true` with no bound) → delete the key. Recursive over the whole `input_schema`; applied on **every** `/v1/messages*` request including passthrough ones. | `proxy.mjs:22-44`, `:200` |
| **`HEAD /` probe**: Claude Code probes the base URL; answered `200` locally, not forwarded. *(M0 on 2.1.277: the probe path is actually `HEAD /api/hello`.)* | `proxy.mjs:185-186` |
| Haiku: delete `thinking`, delete `output_config.effort` (and empty `output_config`), drop `context_management.edits` whose `type` matches `/thinking/i` (and empty `context_management`). Flags are per tier — an older exact model (e.g. Opus 4.1) keeps effort/thinking and may 400. | `proxy.mjs:79-98` |
| `GET /v1/models` (gateway model discovery): buffered to build the catalog; drop `accept-encoding` on the request so it is readable | `proxy.mjs:280-310` |
| Copy headers verbatim, drop `content-length` (Node then sends chunked) | `proxy.mjs:277-285` |
| SSE piped unbuffered: `res.writeHead(status, headers); up.pipe(res)` | `proxy.mjs:315-329` |
| Status-line settings passed as a temp file (inline JSON does not survive the Windows shell) | `jev-claude.mjs:51-71` |
| `~/.claude/settings.json` `model` is restored on exit if the picker persisted the sentinel | `settings.mjs` |

### Stated limitations
- "The user's prompt text is sent to TypeSafe for the routing decision. Nothing else is." — **false in code**: `current_model`, `context_tokens`, and `available_models` are also sent.
- "Claude Code and Codex request formats are not public contracts. Use `JEV_DUMP` to diagnose upstream changes." (We do the same with a separate dump-only proxy, `scripts/spike/capture.mjs`, not an environment variable on the running proxy: a live session never writes request bodies to disk.)
- "Developed and tested on Windows against Claude Code v2.1.101."
- Jev adds latency on the first request of a turn only.

### Weaknesses found in the code
1. **Not fail-open in two places**: (a) on the first request of a conversation, or a continuation with lost state, "current" defaults to **`opus`** (`proxy.mjs:216` ✔ verified), so a Jev outage lands on the expensive tier; (b) if body processing throws on a sentinel-model request, the sentinel id `jev-router` is forwarded to Anthropic and fails.
2. Worst-case added latency ≈ 3 s per fresh turn (1.5 s timeout + 1 retry + 3 s hard deadline); Jev is awaited even when a manual override already decides the outcome.
3. Score questions cost tokens/latency and feed only the status display.
4. No signal handling; predictable shared tmp dir with default permissions containing full prompts; `JEV_DUMP` writes unredacted bodies.
5. `count_tokens` requests match `^/v1/messages` and can trigger routing.
6. A subagent on a non-sentinel model calls `writeStatus(sid,{manual:true})`, overwriting the whole status file and wiping history.
7. `explain.mjs` reads `answers.model_tier` but the router writes `answers.model`; the test fixture hides it.
8. `JEV_API_KEY` and cwd `.env` variables leak into the `claude` child environment.
9. Override regex false positives ("run this on fast hardware", "compare with opus").
10. Confidence never scaled beyond one 0.3 floor; no cost model at all (a fixed 20k-token rule stands in).
11. README/code mismatches (`jev-auto` vs `jev-router`; "default sonnet" vs opus).

## 4. Lessons we adopt

| Lesson | Source | How we use it |
| --- | --- | --- |
| Routing an established main chat loses money (per-model caches); subagents are cold contexts, that's where savings are | jcm | Default scope = subagents only; main chat gated by a cost guard |
| Upgrades cost more than downgrades save | jcm | Never a silent default; tier clamping steps up only to reach an *enabled* tier |
| Retry-with-original on a 4xx after rewrite | jcm | Adopt |
| Byte-identical forward when no change is needed | jcm | Adopt (never re-serialize unless a field changed) |
| Haiku rewrite list (`thinking`, `effort`, `context_management`, `context-1m` beta, mid-convo `system` role) | both | Idea adopted, **recipe not**: M0 showed a native Haiku request keeps `thinking` (as `enabled`+budget) and `context_management`. Profiles are derived from native requests (`wire-format.md` §5) |
| MCP draft-04 schema normalisation, `HEAD /` probe | jev | **Neither reproduced on 2.1.277** (M0): draft-04 schema passed through unchanged with API 200; the probe is `HEAD /api/hello`. Dropped / corrected |
| Fail-open everywhere | both | Adopt, and fix both repos' holes: fallback = *the model the client asked for*, never a fixed tier |
| Never Fable by default | jev | `REFLEX_ALLOW_FABLE=1` |
| Confidence floor / no-downgrade on low confidence | both | Adopt; log confidence and probabilities |
| Pin model for the whole tool loop | both | Adopt |
| Judge reasoning demanded, not reply length | jev | Adopt in the question wording; verify in `test:live` |
| Injectable route/upstream for end-to-end tests | jev | Adopt (fake Jev + fake upstream) |
| Supervisor with passthrough | jcm | Adopt, add a liveness probe |
| Record-only decision journal, with prompt logging off switch | jcm | Adopt |

## 5. What reflex-router does differently

1. **Outcome awareness** — both projects measure cost only. We record, per turn, whether the decision looked wrong (correction, failing test after an edit, revert). Phase 1 records; Phase 2 escalates and tunes.
2. **Shadow mode** — jcm has `dry_run`; jev-router has none. We make it a first-class mode with a `shadow-vs-actual` report.
3. **Pluggable backend** behind `DecisionBackend`, with a stub for a local logit-reading model.
4. **Privacy budget** — hard character caps plus a secret redactor before anything leaves the machine, applied to *everything* sent (both prior projects send more than they document, or send unredacted text).
5. **Session-scoped state**, keyed on the session id from `metadata.user_id`, not on prompt text.
6. **Loopback-only bind**, `127.0.0.1`, no sentinel model id, no edits to `~/.claude/settings.json`, no key leakage into the child env (the Jev key is stripped from the `claude` child's environment).
7. **Latency-bounded**: one hard deadline (no retries) and Jev is never awaited when an override already decides.
8. **Quality-aware reporting** next to cost; savings expressed as token/usage headroom for subscription users.
9. **Wire-format isolation**: everything Claude-Code-version-specific lives in one module with a dump switch.

## 6. Provenance and attribution

No code has been copied yet. Ideas and small algorithms we expect to re-implement (not copy) are listed above. If any code is adapted in implementation — most likely `sanitizeSchema`, the Haiku field list, `foldSystemMessages`, or the SSE usage splitter — it will be attributed in `THIRD_PARTY.md` in the same commit that adds it.
