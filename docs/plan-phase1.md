# Phase 1 plan

Status: **approved 2026-09-19 with three additions (§3.1 version check, §4.3 effort-ready `Decision`, 300-char preview cap in §6). Milestone 0 is complete**; its findings changed several sections, marked *(revised after M0)*. Companions: [`prior-art.md`](./prior-art.md), [`wire-format.md`](./wire-format.md).

Phase 1 = a loopback proxy + CLI wrapper that asks a decision backend (Jev) how much reasoning a piece of work demands, routes **subagent** requests to a suitable model tier, records what happened, and reports on it. It never escalates or self-tunes (that is Phase 2).

## 0. Facts this plan rests on

Verified today (2026-09-19) against primary sources — not from the prior-art repos and not from a subagent's summary. Three claims in an earlier hooks research summary were wrong and were corrected against the docs (Edit/Write field names, `--settings`, Bash exit code).

**Jev** (docs.typesafe.ai): `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, body `{state, model:"jev-latest", questions}`; choice → `{choice, probabilities, confidence}`, score → `{score, legend, confidence, probabilities?}`, noul → `{noul}`; errors 401/422/429/529; 64k-token budget; input-only billing at $0.042/MTok. `confidence` is a spread statistic, **not** the top probability (0.84/0.159/0.001 → 0.596).

**Claude Code hooks** (code.claude.com/docs/en/hooks.md, fetched today; installed CLI is 2.1.277):
- Common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `prompt_id` (≥2.1.196), `permission_mode`, `effort.level`; plus **`agent_id` / `agent_type` only when the hook fires inside a subagent**. All tool hooks fire inside subagents.
- `UserPromptSubmit` → `prompt`. `PostToolUse` → `tool_name, tool_input, tool_response, tool_use_id, duration_ms`. Bash success `tool_response` = `{stdout, stderr, interrupted, isImage}` — **no exit code field is documented**. A failing Bash command fires **`PostToolUseFailure`** with `error: "Exit code 1\n…"` and `is_interrupt`. Edit `tool_input` = `{file_path, old_string, new_string}`; Write = `{file_path, content}`. MultiEdit is not in the docs.
- `SubagentStart` → `agent_id, agent_type`. `SubagentStop` → adds `agent_transcript_path`, `last_assistant_message`.
- **`http` hooks** exist: the event JSON is POSTed to a URL. 2xx + empty body = success; non-2xx, connection failure = **non-blocking** error. Default timeout 600 s, but 30 s for `UserPromptSubmit`.
- `--settings <file-or-json>` layers over user/project/local settings and under managed policy; all matching hooks from all sources run in parallel. Managed `allowedHttpHookUrls` can block http hooks.
- Nothing in the docs says how a request's session or subagent identity appears on the wire.

**Pricing** (platform.claude.com/docs/en/about-claude/pricing, fetched 2026-09-19), $/MTok input / output: Fable 5.1 10/50, Opus 5 5/25, Sonnet 5 2/10, Haiku 4.5 1/5. Cache write 1.25× (5 m) or 2× (1 h); cache read 0.1× — **0.025× on Fable 5.1**. Claude 4.7+ tokenizers emit ~30 % more tokens than older ones, so token counts are not comparable across generations.

**Observed in Milestone 0 on Claude Code 2.1.277** (details and fixtures: [`wire-format.md`](./wire-format.md)):
- Hook `session_id` == the wire's `metadata.user_id.session_id` == the `x-claude-code-session-id` request header. **Verified.** The degrade path is therefore not needed on this version but is still tested (§9) with a mutated fixture.
- **Both** prior-art subagent markers (`cc_is_subagent=true`, `You are an agent for Claude Code`) appear on subagent requests and on no main-chat request. **Verified.** There is also a new header, `x-claude-code-agent-id`, present on subagent requests only and equal to the hooks' `agent_id` (an exact join key).
- The startup probe is `HEAD /api/hello`, not `HEAD /`.
- A failing Bash command fires `PostToolUseFailure` only (`error: "Exit code 1"`); on the wire it is a `tool_result` with `is_error: true`.
- Two `--settings` flags do **not** merge (last wins wholesale); hooks from *different sources* do merge.
- MCP draft-04 boolean `exclusiveMinimum` passes through a custom base URL unchanged and the API answers 200 → the compat rewrite is **not needed**.
- A native Haiku request keeps `thinking` (as `enabled` + `budget_tokens`) and `context_management`, drops `output_config`, caps `max_tokens` at 32000, has no `role:"system"` messages and lacks two betas → the prior-art "delete thinking" recipe is wrong for this version.
- Main-chat requests carry the `extended-cache-ttl` beta (1-hour cache writes); subagent requests do not (5-minute writes).
- **Not covered by M0** (listed in the fixture manifest): interactive TUI entrypoint, forks, background/parallel agents, custom subagents, `Agent` with an explicit `model`, `/resume`, `/compact`, non-macOS.

## 1. Answers to the open design questions

### 1.1 Outcome capture: hooks, not wire parsing

**Recommendation: Claude Code hooks, delivered by `http` hooks to the loopback proxy, injected per invocation with `--settings`.**

Why:
1. **Documented contract.** Hook payloads and their versioning (`prompt_id` needs ≥2.1.196) are documented; the wire format is not. We already have to depend on the wire for *classification*; outcomes should not add a second fragile dependency.
2. **The needed facts arrive as named fields**: the next user message (`UserPromptSubmit.prompt`), edit inputs (`old_string`/`new_string`), command failure (`PostToolUseFailure`), subagent identity (`agent_id`), subagent completion (`SubagentStop`). From the wire we would have to re-derive them by diffing the entire repeated history on every request.
3. **No edits to user files.** `--settings` is per-invocation and layered; `~/.claude/settings.json` is never touched (both prior projects either edit it or restore it after the fact).
4. **HTTP hooks avoid process spawn.** A command hook would start Node once per tool call. An http hook is one loopback POST; the worker already holds session state in memory and persists to `~/.reflex/`.
5. **Safe failure.** Connection failure is non-blocking. The front door (§3) answers hook POSTs with `204` even when the worker is down, so a crashed worker costs lost outcome events, never a failed session or a noisy transcript.

*(revised after M0)* Verified on 2.1.277, and what remains a caveat (each keeps a degrade path, never a hard failure):
- **Verified:** `http` hook delivery works; a failing Bash command fires `PostToolUseFailure` only, with `error: "Exit code N"` (parse N; register both events); hook `session_id` equals the wire session id; **hook `agent_id` equals the request header `x-claude-code-agent-id`**, so subagent events attribute to proxy decisions **exactly** (`attribution: "exact"`), and the main chat joins on `session_id` + turn sequence. The FIFO/prompt-hash matching from the first draft is dropped.
- **Verified:** hooks from different settings sources merge, but **two `--settings` flags do not — the last wins wholesale.** If the user passes `--settings`, the launcher parses it (file or inline JSON), merges our `hooks` into it and passes **one** temp file; if that fails, we skip injection and outcomes are disabled (warned once, shown by `reflex doctor`).
- Still a caveat: a managed `allowedHttpHookUrls` may block loopback → outcomes disabled, decisions still logged. Fallback join if session ids ever stop matching on a future version: `cwd` + time window, tagged `attribution: "session"` (exercised in tests with a mutated fixture).
- Extra corroboration from the wire: a failed Bash `tool_result` has `is_error: true`; recorded as a cross-check, not the primary source.

Wire parsing remains a documented *fallback for Phase 2 only*.

### 1.2 Subagent vs main-chat detection

Signals, strongest first. All live in `src/wire/claude-code.ts`; nothing else reads `body.system`.

*(revised after M0)* All four signals below were **observed on 2.1.277**.

| # | Signal | Observed on subagent / main | Notes |
| - | --- | --- | --- |
| S0 | Request header `x-claude-code-agent-id` present | yes / never | Also the exact join key to hook `agent_id`. Cheapest signal: no body parsing |
| S1 | System text contains `cc_is_subagent=true` (in the `x-anthropic-billing-header:` line) | yes / never | Harness-set, so it covers custom agents too |
| S2 | System text contains `You are an agent for Claude Code` | yes / never | Built-in agents' prompt; supporting evidence only |
| S3 | System text contains `x-anthropic-billing-header:` | yes / yes | Positive evidence that the client is Claude Code at all |

Rule: `subagent` iff S0 ∧ S1; `main` iff S3 ∧ ¬S0 ∧ ¬S1 ∧ ¬S2; **any other combination is `unknown`** (including S0 xor S1, which is logged as `evidence_conflict` and counted as drift). **`unknown` is never routed** (forwarded byte-identical), so a missed detection only costs savings. The one harmful error is a false `subagent` on a real main chat; requiring two independent signals to agree, with all evidence logged on every routed request, is the guard against a future release changing one of them.

Known blind spots: forks inherit the parent's prompt and would classify as `main` (conservative; **not observed yet**, listed as a gap); non-Claude-Code clients classify as `unknown`; the interactive entrypoint (`cc_entrypoint=cli`) was not captured, so S1 there is unproven.

**Stability: medium.** The signals are undocumented harness details, but they are now confirmed on 2.1.277 rather than inherited from repos tested on ≤2.1.101. Mitigations: (1) scrubbed 2.1.277 fixtures are contract tests; (2) drift metric in `reflex doctor`: `|subagent-classified requests − SubagentStart events|` per session, plus `evidence_conflict` counts; (3) markers live in one constants block in `wire/claude-code.ts`; (4) the startup version check (§3.1); (5) `REFLEX_DUMP` for triage.

### 1.3 New turn vs tool-loop continuation

Computed per request in `wire/claude-code.ts`, output `turn: "new" | "continuation" | "none"`:

1. No non-empty `tools` array → `none` (title generation, side calls; passthrough).
2. Take the last non-`system` message (**M0: every Sonnet request ends with one or more `role:"system"` messages, so skipping them is mandatory**). Not `role:"user"` → `none`.
3. It contains a `tool_result` block → `continuation` (parallel tool results are still one message).
4. Otherwise strip `<system-reminder>…</system-reminder>` text; nothing left → `none` (harness-injected reminders are not a user turn); text left → `new`.

**Pinning** (the "model pinned for the entire tool loop" rule): each request gets a `convKey`, session-scoped unlike jcm-router's prompt-only key that collides across sessions. *(revised after M0)* Session id = header `x-claude-code-session-id` (fallback `metadata.user_id.session_id`). Subagents: `convKey = session | agent-id header` — exact, stable across the subagent's requests. Main chat: `convKey = sha256(session | "main" | first-user-message[:2000])`. A `new` turn creates or replaces the pin `{convKey → {promptHash, plan}}`; a `continuation` reuses the pin and re-applies the *same* rewrite without calling the backend. A continuation with no pin (proxy restart, `/resume`, compaction changing message 0) is forwarded unchanged and logged `pin_miss`. A user message that interrupts a loop with new text is `new` and legitimately re-decides. For a subagent, the "turn" is its whole run: its first request is `new`, everything after is `continuation`.

## 2. Scope and rules

| Setting | Values | Default |
| --- | --- | --- |
| `REFLEX_MODE` | `route` \| `shadow` \| `off` | **`shadow`** (safest; user opts into `route`) |
| `REFLEX_BACKEND` | `jev` \| `local` (stub, throws a clear TODO) | `jev` |
| `REFLEX_MAIN_CHAT` | `guarded` \| `never` | `guarded` |
| `REFLEX_UPGRADES` | `off` \| `confident` \| `on` | `off` (jcm measured upgrades as a net loss) |
| `REFLEX_TIERS` | comma list of enabled tiers | `haiku,sonnet,opus` |
| `REFLEX_ALLOW_FABLE` | `1` to allow Fable | unset |

`off` starts `claude` with **no** proxy and no env changes — literally plain `claude`. `shadow` forwards every request unchanged and calls the backend **off the critical path** (fire-and-forget), so it adds no latency; `route` awaits the backend under a hard deadline.

Policy rules, all encoded in `src/policy.ts` as a pure function `plan(view, decision, cfg, session) → RoutePlan` with reason codes:
1. **Fail-open**: any error, timeout, malformed answer, or open circuit breaker → forward the original bytes. The fallback is *the model the client asked for*, never a fixed tier (both prior projects had holes here).
2. **Low confidence never downgrades.** Downgrade needs `confidence ≥ 0.70` *and* the composite veto (§4.3). Thresholds are provisional constants; both `confidence` and `probabilities` are logged so shadow data can retune them.
3. **Pinned for the whole tool loop** (§1.3).
4. **Clamp to enabled tiers, step up not down**: if the chosen tier isn't enabled, use the next enabled tier above it; if none exists, make no change (never silently step down).
5. **Never Fable** unless `REFLEX_ALLOW_FABLE=1` — Fable is not offered to the backend as an option and is never a clamp target.
6. **Manual overrides `!opus !sonnet !haiku` win over everything.** Parsed from the *user's* message on the main chat (leading tokens), stored on the session for the current user turn, and applied to that turn's main-chat requests **and** the subagents it spawns. They bypass the backend, the confidence floor and the cost guard. They do not bypass capability stripping or the fallback-to-original retry.
7. **Upgrades**: disabled by default; in shadow they are logged as `would_upgrade`.
8. **Tier rejection circuit-breaker**: a rewritten request that gets a 4xx (other than 401/403/429) is retried with the original bytes, and that tier is disabled for the session for 30 min (covers plans that don't include a tier).

Tier → model id: `REFLEX_MODEL_<TIER>` > `ANTHROPIC_DEFAULT_<TIER>_MODEL` (documented) > built-in defaults (`claude-haiku-4-5-20251001`, `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5-1`).

**Main chat cost guard** (`src/guard.ts`, prices from `src/pricing.ts`): with measured context `ctx` (input + cache-read + cache-create tokens from the previous response for that `convKey`; **unknown → refuse**):

```
penalty = write(to, ctx) − read(from, ctx)     // write mult chosen from the request itself: 2× (1-h) if its anthropic-beta
                                               // has extended-cache-ttl-…, else 1.25× (5-m) — M0: main chat has it, subagents don't;
                                               // read mult per pricing.ts (0.1×, 0.025× on Fable 5.1)
allow   = penalty ≤ REFLEX_MAX_SWITCH_PENALTY_USD   // default $0.01
```

`from` is the last *routed* model for that convKey (the cache lives there), not the requested one. Evaluated **before** asking the backend: if no target could pass, the backend is not called (saves latency on long chats). This means the main chat is realistically only routed in the first turns of a session; that is intended. `pricing.ts` carries `LAST_VERIFIED = "2026-09-19"` and a header comment that it must be re-checked against the pricing page before each release.

**Effort routing is out of Phase 1** (model tier only). It is a small rewrite (`output_config.effort`) once the tier path is solid; flagged for your decision in §9.

## 3. Architecture

```
                 ┌────────────────────────── reflex (launcher, one process) ──────────────────────────┐
 user ─ reflex ─►│ 1. resolve `claude`, parse config      4. spawn claude (stdio inherit)             │
                 │ 2. bind 127.0.0.1:0 = FRONT DOOR       5. forward SIGINT/SIGTERM/SIGHUP            │
                 │ 3. spawn WORKER (child process)        6. exit with child's code/signal            │
                 └───────────────┬────────────────────────────────────────────────────────────────────┘
        claude ── ANTHROPIC_BASE_URL ──► FRONT DOOR ──(healthy)──► WORKER ──► upstream (Anthropic / user's gateway)
                                            │  └─(worker down / hung / breaker open)─────────────────────► upstream
                                            └─ POST /__reflex/hook ─► WORKER, or 204 if worker is down
                                   WORKER ──► Jev  (redacted, size-limited state, hard deadline, no retries)
                                   WORKER ──► ~/.reflex/decisions.jsonl, outcomes.jsonl
```

- **Front door** (`src/launcher/front-door.ts`, ~150 lines, deliberately dumb): owns the listening socket for the whole session, so there is **no port-unbound gap**. Per request: buffer the body, try the worker; if the worker refuses, errors before sending any byte, or fails its liveness probe → forward straight to upstream with the buffered bytes. A worker that dies *mid-stream* cannot be recovered (Claude Code's own retry handles the broken stream); this is documented.
- **Worker** (`src/worker/`): all routing logic, isolated in a child process so an exception, OOM, or event-loop stall cannot take down the door. Liveness: door probes `GET /__reflex/health` every 2 s (1 s timeout); 3 misses → kill and respawn (backoff 200 ms→5 s); 3 crashes in 60 s → passthrough-only for 60 s before retrying. Fixes jcm-router's "hang is invisible" hole.
- **Upstream** is the user's pre-existing `ANTHROPIC_BASE_URL` if set, else `https://api.anthropic.com` (both prior repos hard-code the latter and break corporate gateways). `REFLEX_UPSTREAM_URL` overrides.
- **Launch**: `ANTHROPIC_BASE_URL` is set in the child env (**M0: sufficient on its own, even when `--settings` is overridden**) and also inside the injected `--settings {"env":{"ANTHROPIC_BASE_URL":…},"hooks":{…}}`, because a `settings.json` `env` block would otherwise override the shell variable (jcm-router's finding). Auth headers are never read, stored or modified; `ANTHROPIC_API_KEY` is left as-is. `TYPESAFE_API_KEY` and all `REFLEX_*` are **stripped from the child's environment**. All inherited `CLAUDE_CODE_*` variables are left alone by the product launcher (only the M0 spike strips them, because it runs inside a Claude Code session). **`--settings` (M0-verified: last flag wins wholesale, no merge)**: if the user passes one or more, we parse them (file or inline JSON; only the flag values are read), merge our `hooks`/`env` into a single temp file and pass exactly one `--settings`; if parsing fails we skip injection, warn once, and run without outcome capture.
- **Argument forwarding**: everything goes to `claude` verbatim. Reflex owns only `reflex report`, `reflex doctor`, `reflex version`; `reflex -- <args>` is the explicit escape hatch.
- **Forwarding fidelity**: raw `http/https.request` piping. Request and response bytes are untouched unless a rewrite applies (byte-identical otherwise; no `JSON.stringify` round-trip). Hop-by-hop headers handled per RFC; `content-length` recomputed only for rewritten bodies. Client disconnect aborts upstream; upstream has a connect timeout but no total timeout (long streams).
- **Response usage capture** (route + shadow): tee the raw bytes to an SSE parser through `zlib` when `content-encoding` is gzip/br/deflate (client still gets the original bytes). Unknown encoding → usage `null`. Split events on `\r?\n\r?\n`.
- **Not routed**: any path other than `/v1/messages` (query string ignored; M0 saw `?beta=true`), including `/v1/messages/count_tokens` (jev-router routes it by accident). Everything else, including the startup **`HEAD /api/hello`** (M0; not `HEAD /`), is forwarded to upstream untouched; only if upstream is unreachable does the front door answer a `HEAD` with `200` so startup is not blocked.

### 3.1 Startup version check *(added on approval)*

The wire-format contract is only known for the versions we have fixtures for, so the launcher checks it before it trusts any signal.

- **Tested set**: the directory names under `test/fixtures/claude-code/` (today: `2.1.277`). A committed generated file `src/wire/tested-versions.generated.ts` is produced by `scripts/gen-tested-versions.mjs` and a test fails if it drifts from the directories (the npm package does not ship `test/`).
- **At launch**: run `claude --version` (3 s timeout), parse `MAJOR.MINOR.PATCH`, and evaluate the pure function `assessVersion(running, tested) → { level: "ok" | "warn" | "degrade", reason }`:

| Running vs tested | Level | Effect |
| --- | --- | --- |
| exact match with a tested version | `ok` | silent |
| same major, different minor/patch | `warn` | one stderr line: running X, tested Y, "signals may have drifted, run `reflex doctor`"; mode unchanged |
| different major | `degrade` | one stderr line; **effective mode becomes `shadow`** even if `REFLEX_MODE=route`, so nothing is rewritten |
| cannot detect or parse | `degrade` | same; we cannot establish the contract |

- **At runtime** the worker also reads `user-agent: claude-cli/<ver>` from the first request (M0: `claude-cli/2.1.277 (external, sdk-cli)`). It is what actually talks to us, so if it yields a different verdict than `claude --version` (e.g. a wrapper script), the more severe verdict wins for the rest of the session.
- Every decision record carries `mode_requested`, `mode_effective`, `degraded_reason`, and `claude_version`. `reflex doctor` prints running version, tested set, verdict, and effective mode. Escape hatch: `REFLEX_IGNORE_VERSION_CHECK=1` suppresses the *degrade* (the warning stays).
- Tests: table tests for `assessVersion` (incl. prerelease/garbage strings) and a launcher e2e with a `fake-claude` that prints different versions.

## 4. Modules

### 4.1 File layout

```
package.json  tsconfig.json  eslint config  LICENSE (MIT)  THIRD_PARTY.md  README.md  CLAUDE.md
docs/  prior-art.md  plan-phase1.md  privacy.md  wire-format.md (written from M0 findings)
bin/reflex.js                       # tiny shim → dist/cli.js
src/
  cli.ts                            # arg split: reflex-owned subcommands vs forward-to-claude
  config.ts                         # ONLY reader of process.env → frozen Config or error list
  pricing.ts                        # price table, cache multipliers, LAST_VERIFIED, "check against pricing page"
  policy.ts                         # ALL policy: questions, option text, thresholds, plan() rules
  guard.ts                          # main-chat cost guard (pure)
  types.ts                          # Decision, DecisionState, Question, RequestView, RoutePlan, records
  launcher/  launch.ts  front-door.ts  supervise.ts  claude-bin.ts  settings-inject.ts
  worker/    main.ts  handler.ts  session-state.ts  breaker.ts  upstream.ts  usage-tee.ts  hooks-endpoint.ts
  wire/                             # THE ONLY place that knows Claude Code / Anthropic body shapes
    claude-code.ts                  #   parse → RequestView: kind+evidence, turn, prompt text, convKey, session id
    anthropic.ts                    #   capability table, rewrite(), schema normalisation, system folding, SSE usage
    dump.ts                         #   REFLEX_DUMP (0600 files, header whitelist, auth headers never written)
  backend/   types.ts (DecisionBackend)  jev.ts  local.ts (stub)  fake.ts (tests)
  privacy/   budget.ts  redact.ts
  log/       decision-log.ts  outcome-log.ts  rotate.ts
  outcome/   heuristics.ts  tracker.ts  schema.ts  hooks-config.ts
  report/    report.ts  format.ts
test/  support/ (no-network guard, fake-jev.ts, fake-upstream.ts, fake-claude.mjs, fixtures/)  unit/ integration/ live/
```

### 4.2 Boundaries (enforced)

- `wire/` is the only importer of raw request/response body structure; a test greps `src/**` (excluding `wire/`) for `tool_result|\.messages|cc_is_subagent|billing-header` and fails on a hit.
- `config.ts` is the only reader of `process.env`; `policy.ts`, `guard.ts`, `heuristics.ts`, `redact.ts`, `budget.ts` are pure (no I/O, injected clock) and are where the test weight goes.
- `backend/` never sees a `RequestView`, only the already-budgeted `DecisionState`.

### 4.3 Backend interface and the Jev question

```ts
interface DecisionBackend {
  readonly id: "jev" | "local";
  decide(state: DecisionState, questions: QuestionSet, opts: { signal: AbortSignal }): Promise<Decision>;
}
// Decision = { answers: Readonly<Record<QuestionId, Answer>>, latencyMs, backendModel, tokensIn }
// Answer   = ChoiceAnswer{choice, probabilities, confidence} | ScoreAnswer{score, levels, confidence, probabilities?} | BoolAnswer{p}
//            — a local logit-reading backend fills the same shapes.
```

**Effort-ready by construction *(added on approval)*.** Nothing in the types or the policy file's structure assumes "one decision = one tier". Phase 2 adds effort by adding entries, not by restructuring:

```ts
type Tier   = "haiku" | "sonnet" | "opus" | "fable";
type Effort = "low" | "medium" | "high" | "xhigh" | "max";        // declared now; Phase 1 never sets it
type Dimension = "tier" | "effort";                                // Phase 1 policy implements only "tier"

interface Pick<V extends string> { value: V; confidence: number; probabilities: Readonly<Record<string, number>> }
interface Judgement { tier: Pick<Tier>; effort?: Pick<Effort>; vetoes: Readonly<Record<string, number>> }   // vetoes = e.g. reasoning_demand
interface Target    { tier: Tier; effort?: Effort }                 // what a plan routes to
interface RoutePlan { target: Target | null; reasons: readonly ReasonCode[]; wouldUpgrade: boolean }
type RewriteOp = { op: "model"; to: string } | { op: "effort"; to: Effort };   // Phase 1 emits only "model"
```

`policy.ts` is organised as three tables, so adding `effort` means one new row in each and no reshuffling:
1. `QUESTIONS: Record<QuestionId, QuestionSpec>` — each spec has `build(cfg)` (the Jev question) and `read(answers) → Partial<Judgement>`.
2. `DIMENSIONS: Record<Dimension, DimensionRules>` — thresholds, floors, clamping and step-up rules per dimension (only `tier` is populated in Phase 1; the shared rules — fail-open, low-confidence-never-downgrades, pinning, overrides — are dimension-generic).
3. `judge(decision, cfg) → Judgement` merges every `read`; `plan(view, judgement, cfg, session) → RoutePlan` applies `DIMENSIONS` rules per key present in the judgement.

The requested effort is already observable (M0: `output_config.effort: "medium"`), so it is **logged now** as `requested.effort`, giving Phase 2 a baseline without a schema change. Logs and outcome records use `picks: Record<Dimension, {value, confidence, probabilities}>` and `target: {tier, effort?}` rather than flat `tier`/`confidence` fields for the same reason.

`JevBackend`: raw `fetch` to `${REFLEX_JEV_BASE_URL ?? https://api.typesafe.ai}/v1/systemone`, key must start `apikey_`, strict runtime validation of the response (a partial/odd answer ⇒ error ⇒ fail-open), `AbortController` hard deadline (default 1500 ms, `REFLEX_BACKEND_TIMEOUT_MS`), **zero retries** (the SDK default of 2 retries × backoff would add seconds), error bodies never logged with the key. Circuit breaker: 3 consecutive failures ⇒ open 60 s ⇒ immediate passthrough.

Questions (`policy.ts`), asked in **one call** (parallel and cheap by Jev's design): 
- `tier` — **choice**: haiku / sonnet / opus (+ fable only when allowed). Instructions judge *the reasoning the task demands*, and say explicitly that reply length, message length and number of files listed are not the measure. Each option has `what` / `not_for` / `examples` (structured, per Jev's "advanced structure").
- `reasoning_demand` — **score**, 5 levels from "mechanical: rename, reformat, run one command" to "open-ended: unknown-cause debugging, cross-module design, security-sensitive change".
- Composite rule in code: a downgrade to haiku requires `tier=haiku ∧ reasoning_demand ≤ 1.0`; to sonnet requires `reasoning_demand ≤ 2.5`. This is Jev's own "atomic questions composed in code" pattern, and it makes the two answers cross-check each other. Both are logged so Phase 2 can tune.

`state` (object, per Jev's guidance to use objects): `{ task, previous_assistant_reply, context: { requesting_tier, is_subagent } }`. Nothing else is sent — no file paths, no tool lists, no session ids — and `docs/privacy.md` lists the exact fields (jev-router's README claimed "nothing else" while sending more; ours is asserted by a test that snapshots the outbound JSON keys).

Whether the exact wording achieves the "reasoning not length" effect reported for jev-router (0.21→0.81 on one prompt) is **unproven for us**: `test:live` includes a ~30-prompt labeled set that compares "length-framed" vs "reasoning-framed" instructions, and Milestone 5 reports the result whichever way it goes.

### 4.4 Privacy budget

`privacy/budget.ts`: `task` ≤ `REFLEX_MAX_USER_CHARS` (default 4000; keep head + tail, since the ask is often at the end), `previous_assistant_reply` ≤ `REFLEX_MAX_ASSISTANT_CHARS` (default 1000; **tail**, not head). Subagent requests have no previous assistant reply. `privacy/redact.ts` runs *after* truncation and *before* the state is built, replacing matches with `[REDACTED:<kind>]`:

- `apikey_…` (TypeSafe), `sk-ant-…`, `sk-…`, `AKIA…`/AWS secret pairs, `ghp_/gho_/ghs_/github_pat_…`, `xox[baprs]-…`, `AIza…`, JWTs (`eyJ….….…`), PEM private-key blocks.
- `Authorization:` / `Bearer <token>` headers.
- `.env`-style lines: `^[A-Z][A-Z0-9_]*=.+$` → value redacted (all such lines, not just key-named ones — a deliberately over-eager choice).
- Best-effort, not a guarantee; entropy-based detection is deliberately out of scope (false positives corrupt the task text). Stated as such in `docs/privacy.md`.

The TypeSafe key is only ever read by `config.ts`, held only in the worker, stripped from the `claude` child env, and a test asserts that no request reaching the fake upstream (headers or body) contains it.

## 5. Data flow (route mode, one request)

```
front door: buffer body → worker healthy? ──no──► upstream (unchanged)
worker.handler:
  1. path ≠ /v1/messages (ignoring ?query)                            → passthrough
  2. JSON.parse fails                                                  → passthrough (raw bytes)
  3. view = wire.parse(body)          (kind+evidence, turn, sessionId, promptText, convKey, requestedModel)
  4. view.turn == none  or  kind == unknown                            → passthrough (+ log reason)
  5. turn == continuation → pin? reuse plan : passthrough(pin_miss)
  6. turn == new:
       a. overrides = parseOverrides(user text)  [main chat] → session.turnOverride
       b. scope: subagent → go; main → REFLEX_MAIN_CHAT=never ? passthrough : guard(ctx known & penalty ok?)
       c. breaker open → passthrough
       d. state = privacy.build(view) ; backend.decide(state, QUESTIONS, deadline)   [shadow: async, after forwarding]
       e. plan = policy.plan(view, decision, cfg, session)  → {target|null, reasons[], wouldUpgrade?}
       f. pin.set(convKey, {promptHash, plan})
  7. plan.target ≠ null and mode == route → body' = wire.rewrite(body, plan)   (model + capability stripping)
  8. forward (body' or original bytes); tee response for usage
  9. 4xx (not 401/403/429) on rewritten request → resend original bytes+headers, disable tier 30 min, mark fallback
 10. on stream end: append decision record with usage
```

*(revised after M0)* **There are no compat rewrites in Phase 1.** The MCP draft-04 normalisation from jev-router did not reproduce (M0: unchanged schema, API 200), so it is dropped, and `shadow` (and `off`, and every passthrough) forwards **byte-identical** requests — the acceptance criterion holds without exception. The only rewrites are *routing* rewrites, in `route` mode only.

**Capability profiles are derived from what Claude Code itself sends** (`wire/anthropic.ts`): to retarget a request to another model family, transform it to look like the native request Claude Code produces for that family. From the M0 captures, retargeting Sonnet → Haiku 4.5 means:

| Field | Rewrite |
| --- | --- |
| `model` | the Haiku id |
| `thinking` | `{type:"adaptive",…}` → `{type:"enabled", budget_tokens: 31999, display: <kept>}` (native Haiku shape) |
| `output_config` | remove (it only held `effort`; keep any other keys) |
| `max_tokens` | `min(current, 32000)` |
| `role:"system"` messages | fold into the adjacent user message (tool_result blocks stay first) — native Haiku requests have none |
| `anthropic-beta` | remove `effort-2025-11-24`, `mid-conversation-system-2026-04-07`, and any `context-1m-*` |
| `context_management` | **keep** (native Haiku keeps it — contradicts prior art) |

Each profile row is tagged `observed` (seen in a native request, with fixture) or `inherited` (from prior art). **Whether the API accepts every individual mismatch is unverified**; the M3 experiment (below) tests the rewrite against the real API before route mode is trusted, and the retry-with-original safety net and tier circuit-breaker (§2 rule 8) stay regardless. Up-tier rewrites (Haiku → Sonnet) are only produced when upgrades are enabled and use the same table in reverse (`thinking` → adaptive, add `output_config.effort`, betas).

## 6. Logging

`~/.reflex/` (`REFLEX_HOME`), dir `0700`, files `0600`, size-rotated (10 MB × 5; both prior projects' journals grow without bound).

`decisions.jsonl`, one record per decision, appended after the response completes (schema `v:1`): `id, at, session (hashed), conv, kind, evidence[], turn, mode_requested, mode_effective, degraded_reason|null, claude_version, backend, requested{model, tier, effort|null}, decision{picks{tier{value,confidence,probabilities}}, vetoes{reasoning_demand}, latencyMs, tokensIn}|null, plan{target{tier,effort?}|null, would_route_to, routed_to, reasons[], would_upgrade}, guard{ctx, penalty, allowed}|null, override|null, forwarded{model, rewritten:boolean, fallback:boolean}, upstream{status, msToHeaders}, usage{input, output, cache_read, cache_create}|null, error|null, sent{keys[], chars}, prompt_preview` (redacted, **capped at 300 chars**; `REFLEX_LOG_PROMPTS=0` omits it entirely; the cap is a constant enforced in the logger, not a config value, and a test asserts it on multi-byte text).

`outcomes.jsonl` — §7. `REFLEX_DUMP=<dir>` writes full request bodies for triage, `0600`, no auth headers, with a startup warning that it contains prompts.

## 7. Outcome capture (record only)

Hooks injected via `--settings` (§1.1): `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, all `type:"http"` to `http://127.0.0.1:<port>/__reflex/hook`, `timeout: 2`. The worker normalises them into a per-session event stream; `outcome/tracker.ts` keeps an *open window* per decision (main: until the next `UserPromptSubmit`; subagent: until `SubagentStop`) and emits one record when the window closes.

```ts
interface OutcomeRecord {           // outcomes.jsonl, v:1 — one per closed decision window
  v: 1; at: string; decision_id: string; session: string; turn_seq: number;
  agent_id?: string; agent_type?: string; attribution: "exact" | "fifo" | "session";
  routed_tier: Tier; requested_tier: Tier; mode: Mode; confidence: number | null;
  signals: {
    correction:        { detected: boolean; score: number; matched: string[] };   // from the NEXT user prompt
    test_fail_after_edit: { detected: boolean; edits: number; command?: string; exit_code?: number; failures: number };
    edit_reverted:     { detected: boolean; files: string[]; kind?: "inverse_edit" | "git_restore" };
  };
  counts: { tool_calls: number; edits: number; bash_failures: number; duration_ms: number };
}
```

Heuristics (`outcome/heuristics.ts`, pure, table-tested; every threshold is a named constant so Phase 2 can tune):
- **correction**: weighted phrase/pattern score on the next prompt's first 300 chars ("no,", "that's wrong", "not what I asked", "undo", "revert", "try again", "still failing", "you broke", "doesn't work"), boosted for short prompts starting with a negation; `detected = score ≥ 1.0`. Multilingual coverage is a stated limitation.
- **test_fail_after_edit**: a Bash command matching a test/build/lint runner regex (`npm|pnpm|yarn test`, `pytest`, `go test`, `cargo test`, `vitest`, `jest`, `mvn|gradle test`, `tsc`, …) that produced `PostToolUseFailure` with `Exit code N` **after** ≥1 Edit/Write in the same window and same agent scope.
- **edit_reverted**: a later Edit whose `new_string` equals an earlier edit's `old_string` on the same file (`inverse_edit`), or a Bash `git checkout -- / restore / reset --hard / revert` touching an edited file (`git_restore`).

Deliberately absent in Phase 1: escalation, retroactive re-routing, threshold changes. The schema exists so Phase 2 can join `decision.confidence/probabilities` to these signals and fit thresholds per repo (`cwd`-hash is stored on the decision).

## 8. `reflex report [--since 2h]`

Reads both JSONL files; no network. Sections: decisions by tier and by kind; confidence histogram (deciles, and separately `probabilities[chosen]`); **shadow-vs-actual** (agreement matrix requested-tier × would-route-tier, plus what fraction of tokens each cell carries); guard skips; fallbacks and breaker openings; latency p50/p95 of the backend and of added route latency; **quality side by side** — correction / failing-test / revert rates for downgraded decisions vs unchanged ones, with `n` shown and a hard "insufficient data" line under a minimum sample so small numbers are not read as findings.

Cost delta: token counts from the response `usage` priced with `pricing.ts` at the routed model (actual) vs at the requested model (counterfactual, same token counts — stated as an approximation because tokenizers differ by generation and cache behaviour may differ). Default output is **usage headroom**: "% of the counterfactual price-weighted token spend avoided", explicitly labelled an estimate from API list prices that says nothing about any plan's real limits; `--usd` adds dollars for API-billed users. The user's plan type is a flag (`REFLEX_BILLING=subscription|api`), not detected — detecting it would mean inspecting credentials.

## 9. Test plan

Stack: Node 20+, strict TS (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), `node:test` + `tsx`, zero runtime dependencies. `npm test` = typecheck + lint + all offline tests. A global test setup **blocks any non-loopback socket and DNS lookup**, so "no real network" is enforced rather than promised.

| Layer | What | Tooling |
| --- | --- | --- |
| Unit, pure | `policy.plan` decision table (every rule in §2 × tier/confidence/enabled-tier/fable/upgrade/override combos); `guard` incl. unknown ctx and Fable's 0.025× read; `wire` turn detection (tool_result, parallel results, system-reminder-only, no tools, interleaved user text); subagent detection (S1/S2/S3, forks, unknown, malformed system); capability stripping per family; capability-profile rewrite (Sonnet→Haiku per §5 table, checked field-by-field against the native Haiku fixture); `role:"system"` message folding; hook↔request join by agent id; `--settings` merge (file/inline/multiple/invalid); redactor (each token class, false-positive corpus, multi-line `.env`); privacy budget (head/tail, unicode boundaries); override parser; outcome heuristics (phrase table, edge cases); log rotation; config parsing/errors; SSE usage parser (chunk splits at every byte offset, `\r\n`, gzip/br) | table-driven |
| Integration | Real front door + worker + **fake upstream** (SSE, gzip, 4xx-on-model) + **fake Jev** (`/v1/systemone`, scriptable answers, latency, 401/429/529, hang, junk JSON). Cases: shadow forwards byte-identical and logs would-be decision; route rewrites subagent, leaves main; continuation pinned with **zero** extra Jev calls; override honoured with no Jev call; low-confidence no-downgrade; tier clamp step-up; Fable blocked; 4xx → retry original → tier disabled; Jev timeout/500/junk → byte-identical forward; breaker opens and stops calling Jev; no Jev key ever reaches upstream; outbound Jev body keys match the documented allow-list | node http servers on port 0 |
| Resilience | Worker crash → passthrough within one request; worker hang (liveness) → respawn; crash loop → passthrough mode; door never drops the port; killing the worker mid-stream yields a clean client error, not a hang | fake worker scripts, tiny timings |
| Launcher e2e | `fake-claude` script: asserts arg forwarding (incl. `--`, unknown flags), env (`ANTHROPIC_BASE_URL` set, `TYPESAFE_API_KEY` and `REFLEX_*` absent), `--settings` content, `HEAD /`, exit code and signal propagation, SIGINT forwarding; `REFLEX_MODE=off` leaves env untouched | child_process |
| Outcomes | Recorded hook-event scripts (from M0) replayed to the endpoint → expected `OutcomeRecord`s; hooks endpoint returns 204 when the worker is down | fixtures |
| Contract | Scrubbed real 2.1.277 request bodies from M0 → `wire.parse` snapshots; fails loudly when the format drifts | fixtures |
| Report | Golden-file output from synthetic JSONL; empty, single-record, and huge-file cases | golden |
| Live (`npm run test:live`) | Skipped unless `TYPESAFE_API_KEY` is set: response-shape round trip; latency sample; the reasoning-vs-length labeled set | real Jev |

Manual acceptance checklist (needs a real Claude Code session, run by you or with your OK) mirrors the four acceptance criteria; recorded in `docs/acceptance.md` with results.

## 10. Milestones (each ends with: done / left / risks)

- **M0 — Wire spike: DONE 2026-09-19** (3 real runs, ≈$0.48 total). Deliverables: `scripts/spike/{capture,summarize,redact-fixtures}.mjs`, redacted fixtures in `test/fixtures/claude-code/2.1.277/` (+ `manifest.json`), [`docs/wire-format.md`](./wire-format.md). Verified: session-id equality, both subagent markers plus a new agent-id header, hook↔request exact join, Bash-failure hook event, `--settings` merge semantics, HEAD probe path, MCP draft-04 non-issue, native Haiku shape. Plan sections revised accordingly.
- **M1 — Skeleton**: package, tsconfig, lint, CI, `config.ts`, launcher + front door + supervisor + fake-claude e2e, **version check (§3.1) + generated tested-versions**, passthrough only, `CLAUDE.md`, `LICENSE`, `THIRD_PARTY.md`.
- **M2 — Shadow**: `wire` parse, `policy`, `privacy`, `DecisionBackend` + `JevBackend` + fake Jev, decision log. Shadow works end to end.
- **M3 — Route**: rewrite + capability table, pinning, overrides, guard, breaker, retry-with-original. **Starts with a rewrite experiment** (needs your OK, ≈$0.10): a spike proxy that retargets one real Sonnet request to Haiku per the table in §5 and reports which field mismatches the API rejects, so the profile is `observed`, not guessed.
- **M4 — Outcomes**: hooks injection, endpoint, tracker, heuristics.
- **M5 — Report & acceptance**: `reflex report`, `docs/privacy.md`, README (no unmeasured claims), live tests, acceptance run.

## 11. Risks

1. **Wire drift** (highest). Mitigated by M0 fixtures, one isolated module, contract tests, the startup version check (§3.1: warn, degrade to shadow on a major mismatch), the drift metric, `REFLEX_DUMP`. Residual: a minor/patch update can silently degrade routing to "unknown ⇒ untouched" (safe, shows up as lost savings) — hence the drift line in `reflex doctor`/report — and M0 covered only the non-interactive entrypoint, one OS, and no forks/parallel agents.
2. ~~Hook/wire session-id mismatch~~ — verified equal on 2.1.277; the `attribution:"session"` fallback remains for future versions and is tested with a mutated fixture.
3. **Jev latency on the critical path** of every subagent spawn (route mode). Bounded by the 1.5 s deadline and breaker; measured, not assumed; shadow is latency-free.
4. **Confidence semantics**: 0.70 is copied from jcm-router, whose own tuner preferred 0.65 and whose eval rested on four decisions. Provisional; retuned from shadow data.
5. **Tier availability** is not discoverable without touching credentials; handled reactively via the 4xx circuit-breaker and `REFLEX_TIERS`.
6. **`--settings` collisions / managed policy** may disable hooks or env injection; degrade paths above, surfaced by `doctor`.
7. **Cost estimates** compare like token counts across tokenizer generations; labelled as approximate everywhere they appear. Pricing table can go stale; carries a verification date.
8. **Savings are unproven for our design.** jcm-router measured that subagent routing helps and main-chat switching loses; we inherit that as a hypothesis, and the README will make no claim until our own shadow data supports it.

## 12. Decisions (resolved 2026-09-19)

Approved as recommended, plus three additions: (1) M0 verifies session-id equality and both markers, saves redacted version-tagged fixtures — done; (2) startup version check — §3.1; (3) effort-ready `Decision`, 300-char preview cap — §4.3, §6.

| # | Decision | Outcome |
| - | --- | --- |
| 1 | M0 spike on your Claude account | done, ≈$0.48 |
| 2 | Shadow-mode MCP compat exception | **moot**: not needed on 2.1.277; shadow rewrites nothing |
| 3 | Tier only in Phase 1, effort deferred | approved; types are effort-ready (§4.3) |
| 4 | Default `REFLEX_MODE=shadow` | approved |
| 5 | Prompt preview default-on, opt-out | approved; **cap 300 chars** |
| 6 | Rename `master` → `main` | done |

## 13. Open items for your next decision (after M0)

1. **M3 rewrite experiment** (≈$0.10 of real requests) before route mode is built — see §10. Recommended.
2. **Interactive capture**: I cannot drive the TUI here (no tmux). If you want the `cc_entrypoint=cli` fixtures, run `node scripts/spike/capture.mjs`, use Claude Code normally for a minute including one subagent, exit, then send me the `_dumps/<dir>` name (raw dumps stay local). Recommended before M2's contract tests are frozen, but not blocking M1.
