# M5 handoff

State of reflex-router at the end of M4 (2026-09-19), for a fresh session that builds M5 and runs the Phase 1 acceptance. Read `CLAUDE.md` first (commands, rules), then this, then `docs/wire-format.md` and `docs/observations.md` as needed.

## 1. Architecture (one page)

```
reflex (launcher process)                                   src/launcher/, src/cli.ts, src/config.ts
  config        loadConfig(env): the only reader of process.env; frozen Config or errors (fail -> plain claude)
  version       claude --version vs tested set (src/wire/tested-versions.generated.ts): ok | warn | degrade(route->shadow)
  front door    127.0.0.1:<port> for the whole session; buffers each request; worker healthy? -> worker, else upstream.
                /__reflex/hook: forwards to the worker, answers 204 itself when the worker is down
  supervisor    one worker child process; liveness probe, restart with backoff, crash loop -> passthrough
  claude        spawned with stdio inherited; env minus REFLEX_*/TYPESAFE_*; ANTHROPIC_BASE_URL -> front door;
                exactly one --settings file (the user's own merged in) with env + the outcome http hooks
worker (child process)                                      src/worker/
  server        per request: router.prepare -> forward (net/) -> tee usage -> relay; a rejected rewrite (4xx other
                than 401/403/408/429) is re-sent once with the original bytes and headers
  router        parse (wire) -> shape check -> classify; shadow: decide off the critical path; route: decide under the
                Jev deadline, apply policy + cost guard + context ceiling + verified-pair list, pin per conversation
                (per agent id for subagents), rewrite (wire/rewrite.ts); one decision record per classified request
  outcome       hook events -> OutcomeTracker (src/outcome/): windows per user turn (prompt_id) and per subagent
                (agent id); outcome / outcome_update / harness_injected records next to the decisions
src/wire/       the only code that knows Claude Code / Anthropic shapes: classification (kind, turn, side_kind),
                markers (incl. injected-prompt markers), shape checks, SSE usage + error parsing, retarget rewrite,
                STRIP_BETAS, verified retarget pairs
src/policy.ts   questions, judge (mass | argmax readings), plan (tier dimension; effort-ready types)
src/guard.ts    main-chat cache-penalty guard (pure); src/pricing.ts list prices (LAST_VERIFIED 2026-09-19)
src/privacy/    budget (head/tail by code point), redaction, the allow-listed Jev state
src/backend/    DecisionBackend; JevBackend over node:https with a keep-alive agent, warmed at worker start
src/log/        JSONL writer (0700/0600, 10 MB x 5 rotation); decision log
```

Key behaviours already in place: side calls are never rewritten; a guard refusal or a backend failure keeps a main-chat conversation on its current pinned tier (`stay_pinned`, `stay_pinned_backend_error`), moving up is never guarded (`return_up`); overrides are `reflex:haiku|sonnet|opus` at the start of the user's own text; verified retargets: Sonnet→Haiku, Opus→Sonnet, Opus→Haiku; Haiku drops the `context-1m-*` beta; Haiku's context ceiling is 150k estimated tokens.

## 2. Record schema (`~/.reflex/decisions.jsonl`, one JSON object per line, `v: 1`)

All records carry `v`, `record`, `id`, `at`, `session` (sha256 of the session id, 16 hex). Records written before M4 have no `record` field: treat it as `"decision"`.

**`record: "decision"`**: one per classified `POST /v1/messages` (src/log/decision-log.ts).
- Classification: `conv` (hashed conversation key), `kind` (main | subagent | unknown), `signal` (header | marker:cc_is_subagent | marker:agent_prompt | none), `signals{header,s1,s2,s3}`, `turn` (new | continuation | side), `side_kind`, `entrypoint`.
- Mode: `mode_requested`, `mode_effective` (route | shadow), `degraded_reason`, `shape{status, violations[]}`, `claude_version`, `backend`.
- `requested{model, tier, effort}`.
- `decision` (new turns that reached the backend): `picks.tier{value (applied), confidence, probabilities}`, `rule` (mass | argmax), `pick_mass{value, above_mass}`, `pick_argmax{value, confidence}`, `vetoes{reasoning_demand}`, `latencyMs`, `tokensIn`, `backendModel`, `connection` (new | reused). Null otherwise.
- `plan{target{tier}|null, would_route_to, routed_to, reasons[], would_upgrade}`. Reason codes: `src/types.ts` (`downgrade`, `low_confidence`, `veto_reasoning_demand`, `same_tier`, `upgrade_*`, `clamped_up`, `context_ceiling`, `no_enabled_tier`, `main_chat_disabled`, `override`, `guard_blocked`, `stay_pinned`, `stay_pinned_backend_error`, `return_up`, `tier_disabled`, `rewrite_unverified`, `rewrite_failed`; shadow-1 records also carry the retired `guard_not_evaluated`).
- `guard{allowed, reason (fresh | no_switch | within_limit | over_limit | ctx_unknown), ctx, penalty_usd}|null`, `override` (tier | null), `pin` (set | hit | miss | null).
- `forwarded{requested_model, model (actually sent), rewritten, fields[] (e.g. "model", "output_config.effort", "thinking", "messages.system_folded:1", "anthropic-beta:-context-1m-2025-08-07"), fallback, fallback_status, fallback_error}`.
- `upstream{status, msToHeaders}`, `timing{decision_wait_ms, decision_deadline_ms, upstream_first_byte_ms}` (added after M4: absent in earlier records; `decision_wait_ms` = time the request waited for the backend, route mode `new` turns only, 0 otherwise, bounded by `decision_deadline_ms` + 250 ms grace; `upstream_first_byte_ms` = from handing the request upstream to its response headers, including a rejected first attempt and the retry; `msToHeaders` ≈ the two plus router work), `usage{input, output, cache_read, cache_create}|null`, `usage_unknown_reason`, `error` (category, e.g. `backend:timeout`, `decision_late`), `sent{keys[], chars}`, `prompt_preview` (redacted, ≤ 300 code points; absent with `REFLEX_LOG_PROMPTS=0`).

**`record: "outcome"`**: one per closed window (src/outcome/tracker.ts).
- `decision_id` (null: see `no_decision`), `turn_id` (hashed prompt_id, main only), `turn_seq`, `scope` (main | subagent), `agent` (hashed), `agent_type`, `attribution` (prompt_id | agent_id | interjection; `interjection` windows share their decision with the turn that owns it, so the report counts them separately and never inside a per-arm rate), `models{requested, sent}`.
- `window{closed_by (next_prompt | subagent_stop | session_end), duration_ms, ms_to_last_stop}`.
- `counts{edits, bash, bash_failures, test_runs, test_failures, injected_prompts}`.
- `signals.correction{score, matched[] (rule ids), prompt_chars}|null` (null: no next typed prompt); `signals.test_failure_after_edit{detected, runs[{kind, exit_code, edits_before}]}`; `signals.reverted_edit{detected, events[{kind (inverse_edit | write_restore | git_restore), file (hashed), offset_turns}]}`.
- `params{heuristics_version, revert_window_turns, correction_window_chars}`.
- **`no_decision`** `{reason: "no_wire_turn" | "slash_command" (reserved), nearest_wire: "new" | "continuation" | "side:<kind>" | null} | null`: present exactly when `decision_id` is null.

**`record: "outcome_update"`**: a revert found after its window closed: `decision_id`, `turn_id`, `turn_seq`, `scope`, `agent`, `signal: "reverted_edit"`, `detail{kind, file, offset_turns, detected_in_turn_seq}`.

**`record: "harness_injected"`**: a wire `new` main turn that no `UserPromptSubmit` accounts for (only raised in sessions where prompt hooks arrive, and not for slash-command expansions): `decision_id`, `conv`, `reason: "no_user_prompt_submit"`.

Join: `outcome.decision_id` / `outcome_update.decision_id` / `harness_injected.decision_id` = `decision.id`.

## 3. Archived logs

All under `~/.reflex/` on the maintainer's machine (not in the repo). Sessions are identified by the hashed `session` field. Claude Code's own transcripts of these sessions exist under `~/.claude/projects/*/<session-uuid>.jsonl` (match by hashing the file name); `scripts/spike/replay-transcripts.mjs` uses them.

| File | Session (hash prefix) | What it exercised |
| --- | --- | --- |
| `archive/shadow-1.jsonl` (61) | `383bb180` | Shadow dogfood, Opus requested, before keep-alive and the mass rule: 12 decisions (5 low_confidence under argmax), latency p50 823 / p95 1136 ms cold |
| `archive/route-1.jsonl` (71) | `86577c30` | Route acceptance A: subagents Opus→Sonnet pinned through loops; main chat over_limit before Jev; one Opus→Haiku 400 fallback (pre-`fallback_error`, cause later found to be the long-context beta); ctx_unknown after `/compact` |
| | `1cc8b715` | Session B, first run: B1 fresh → Sonnet, B2 back to Opus (the pre-fix guard revert; side calls kept Opus's cache warm) |
| | `ba0f7059` | One no-tools side call from a short-lived session |
| `archive/route-2.jsonl` (42) | `eec092bf` | Session B, second run: `reflex:haiku` → 400 "long context beta is not yet available" (recorded in `fallback_error`), `reflex:opus` same_tier |
| | `1dc50458` | Session C: main and subagent `backend:timeout` forwarded unchanged; guard blocked two main turns before Jev |
| `archive/route-3.jsonl` (18) | `caacab3b` | Session B after the beta fix: B1 Haiku with the beta stripped and pinned, B2 `return_up` to Sonnet, B3 override to Opus |
| `decisions.jsonl` (current, 86) | `27fc5072` | M4 acceptance 1: correction scores (1.0 on turn 2, `en:undo` 0.8 on turn 3), `outcome_update` inverse_edit on turn 1 |
| | `86d1d76f` | M4 acceptance 2: `test_failure_after_edit` (node-test, exit 1), a subagent outcome joined to its own decision, seq 5/6 windows opened by injected messages (recorded before the injected-message fix) |

Other evidence in the repo: `test/fixtures/claude-code/2.1.277/` (redacted requests incl. interactive and `opus[1m]` shapes, hook streams, and every experiment's results; `manifest.json` has labels and findings).

## 4. M5 scope

**`reflex report [--since 2h] [--usd]`** (reads the JSONL files only, no network; golden-file tests from synthetic JSONL incl. empty, single-record and large inputs):
1. Decisions by kind, turn and tier (requested → applied), mode and degraded reasons.
2. **mass vs argmax**: agreement matrix of `pick_mass` × `pick_argmax`, and what each rule would have routed.
3. **Shadow vs actual**: requested tier × would-route tier, with the share of tokens each cell carries; routed records: requested vs sent model.
4. **Guard skips**: counts by guard reason, penalties, how many skipped the backend.
5. **Fallbacks and breaker**: `fallback_status` / `fallback_error` counts, `tier_disabled`, `breaker_open`, backend error categories.
6. **Latency**: Jev p50/p95 split by `connection` (new vs reused); added route latency (msToHeaders of routed vs unrouted new turns).
7. **Outcome rates for routed vs unchanged turns**, with sample sizes: correction score distribution, `test_failure_after_edit`, reverts (incl. `outcome_update`), per scope; an explicit "insufficient data" line under a minimum n.
8. **Cost at list prices** (`src/pricing.ts`, stated as an estimate: same token counts priced at the sent vs the requested model; tokenizer and cache differences are not modelled): usage headroom by default, dollars with `--usd`.
9. **Side-call usage on its own line**: `turn: side` usage on the requested model, never attributed to routed models.
10. **Cache writes by move type**: down, up one tier, back to requested (observations.md: moving up one tier can write more than returning to the requested model).

**Live Jev tests** (`npm run test:live`, skipped without `TYPESAFE_API_KEY`): response-shape round trip; latency sample with connection reuse; the ~30-prompt labelled **reasoning-vs-length** set comparing length-framed and reasoning-framed instructions. Report the result either way.

**`~/.reflex/env` config**: a `KEY=value` file (for `REFLEX_*`, `TYPESAFE_API_KEY`) read by the launcher and merged **under** the process environment (process env wins) before `loadConfig`; refuse a file readable by group/others when it holds `TYPESAFE_API_KEY`; `reflex doctor` shows which source each setting came from. `config.ts` stays the only place that interprets settings.

**Packaging and README pass**: `npm pack --dry-run` contents (bin, dist, LICENSE, THIRD_PARTY.md, README.md), `engines`, a clean install smoke test, `reflex doctor`; README: no unmeasured claims (numbers only with a pointer to `docs/observations.md`), route-mode caveats, privacy pointer; re-check `src/pricing.ts` against the pricing page and bump `LAST_VERIFIED`.

**Open items carried into M5/Phase 2** (not M5 blockers): undo-family correction attribution when a revert has `offset_turns > 0`; the `unclassified` side call seen in session B; Opus→Sonnet with effort other than `medium` untested; upgrades and Fable retargets unverified.

## 5. Phase 1 acceptance checklist (run at the end, record results in `docs/acceptance.md`)

1. **Off is plain claude**: `REFLEX_MODE=off reflex …` starts `claude` with no proxy, no `--settings`, untouched env.
2. **Shadow is invisible**: a real session in shadow mode forwards every request byte-identical (only `accept-encoding` narrowed); decisions logged; no added latency on the critical path.
3. **Route mode**: a real session where a subagent is routed and pinned through its loop, a main-chat first turn routed behind the guard, a later turn refused by the guard staying on its pin, an override applied, and at least one fallback or `stay_pinned_backend_error` path exercised; every routed record lists requested model, sent model and rewritten fields.
4. **Fail-open**: kill -9 the worker mid-session (the next request is served directly); make Jev unreachable (requests forwarded unchanged within the deadline); corrupt config (plain claude with a warning).
5. **Outcome capture**: edit, failing test, correction, revert in one session, each joined to the right decision; injected messages do not close turns.
6. **Report**: `reflex report` on the archived logs plus the acceptance session; every section present, sample sizes shown.
7. **Privacy**: grep `~/.reflex/decisions.jsonl` for prompt text, paths and keys (none beyond the redacted 300-char previews); the TypeSafe key never reaches the upstream (tests) and never appears in logs.
8. **Tests and packaging**: `npm test` green, `npm run test:live` run with a key and its results recorded, `npm pack --dry-run` contents as expected, pricing re-verified.
