# Changelog

None of these versions has been published to a registry.

## Unreleased

- CI: `actions/checkout` and `actions/setup-node` bumped to v7, `ubuntu-latest` pinned to `ubuntu-24.04` in the test matrix. No functional change.

## 0.2.3-alpha — 2026-09-19

Measurement only: nothing routes differently from 0.2.2-alpha. `REFLEX_ROUTE_SIDE` was designed, priced and **not built** — see `docs/observations.md`, "side-call routing: priced, and parked".

- **`reflex report` section 12, side-call routing estimate.** What sending the harness's own side calls to a cheaper shared tier would have cost on your log, with every cold cache write paid in full, priced for both candidate tiers at both cache-write TTLs, gross and net of the conversations that would lose a free warm cache. It reports warm-vs-cold amortisation against the break-even each tier needs, and flags calls too large for a tier's context window as unroutable rather than counting them as savings.
- **Section 9 names what the optional Claude Code features cost**, with the switch that turns each off: Session recap (`/config` → Session recap, `awaySummaryEnabled`) and Prompt suggestions (`/config` → Prompt suggestions, `promptSuggestionEnabled`). On one day of the maintainer's own work these were **$11.82 at list prices**, against a best-case side-routing saving of $3.39 and a measured routing saving of $3.33. No advice, just the numbers and the switch names.
- **`side_marker`** on decision records: which harness marker named a side call. Claude Code's AFK session recap and its background task notifications share the `notification` side kind but only the recap has a switch, so the feature table attributes by marker. Records from older builds carry none and are counted separately rather than attributed by kind.
- **`cache_ttl_beta`** on decision records: whether the request carried the `extended-cache-ttl` beta. The wire computed this and threw it away, so no log could say whether cache writes were 1-hour or 5-minute — a distinction worth **18×** in the side-routing estimate.
- `docs/wire-format.md` §5.1 records an unverified branch of the rewrite recipe (an empty `output_config`, and `output_config.format` without `effort`), reached only if side-call routing is ever implemented.

## 0.2.2-alpha — 2026-09-19

Phase 2b groundwork. Nothing routes differently yet except what is listed here; side-call routing itself is designed but not implemented (`REFLEX_ROUTE_SIDE` does not exist in this version).

- **Side calls Claude Code makes are now named instead of falling to `unclassified`.** The AFK session recap ("The user stepped away and is coming back…") is a `notification`; tool results carrying harness text are the new side kind `tool_result_text`, recognised by shape rather than by a marker.
- **A message typed into a running tool loop is no longer mistaken for a side call.** It is a `continuation` carrying `interjection: true`: the turn's pin is held and no new decision is taken. The classifier and the fingerprint now share one test for "is this text a prompt the user typed" (`src/wire/typed-prompt.ts`), so they cannot disagree about the same sentence; that also stops empty text matching any prompt, so `FINGERPRINT_VERSION` is **2**.
- **Fix: a correction typed mid-tool-loop is no longer lost.** Such a prompt opened an outcome window that joined no decision, so the correction in the *next* prompt was written with `decision_id: null`. The window now joins the pinned conversation's own decision (`attribution: "interjection"`). Because that decision then owns two windows, `reflex report` counts interjections in an arm of their own and never inside a per-arm rate, so the outcome `n` the calibration gate waits on stays honest.
- **`reflex doctor` fails loudly when `REFLEX_DELEGATE=1` cannot work.** `REFLEX_MODE=off` and any effective mode of `passthrough` run `claude` directly with no settings file, so reflex's `UserPromptSubmit` hook is never installed and the hint is silently lost. Doctor now prints a `hint injection:` line naming the reason and exits 1.
- **`REFLEX_WARM_INTERVAL_MS`** (default 60000, 0 disables): the worker pings the decision backend on an interval to hold its keep-alive connection open between turns, in shadow and route mode only. The first decision after an idle gap otherwise pays a fresh handshake (p50 823 ms new vs 382 ms reused; different sessions, not a controlled comparison). Whether it helps is measurable from the existing `connection` field; **not yet measured.**
- No fixture covers the recap, `tool_result_text` or an interjection: they were seen in a route-mode log, which stores fingerprints and not bodies. They are synthetic unit cases and are listed in the 2.1.278 manifest's `gaps` (`docs/wire-format.md` §4.2).

## 0.2.1-alpha — 2026-09-19

- Fix: a subagent's hand-back is no longer treated as a prompt the user typed. Claude Code delivers a subagent's report to the main chat through `UserPromptSubmit`, so outcome capture closed the user's turn on it, opened a window of its own, and scored the report's text as the user's correction of the previous reply. A hand-back (`isHandbackPrompt`, the marker already in `src/wire`) now takes the same path as a harness-injected message: the user's turn stays open, tool events after it join that turn, the text is never scored, and it is counted in `counts.injected_prompts`.
- Claude Code **2.1.278** added to the tested versions, with redacted fixtures for a Dynamic Workflow (`ultracode`) session. Workflow workers are ordinary subagents on the wire (`x-claude-code-agent-id` **and** `cc_is_subagent=true`) and are classified correctly with no change; they request the **session's own model**, so the requested-tier logic is unchanged. Hook `agent_type` has the new value `workflow-subagent`. Details and limits: `docs/wire-format.md` §7.1, `docs/observations.md`.
- Measured, in `docs/observations.md`: one `ultracode` prompt put **65.8% of its tokens and 74.7% of its dollars into workflow workers** (4 workers, 1.5M tokens, $2.65 at list prices, killed early). This is the first measurement behind the README's warning that delegation can raise total spend.

## 0.2.0-alpha — 2026-09-19

Phase 2a: measure where the tokens go before tuning anything (docs/observations.md, first real-work dogfood).

- `reflex report` section 0, **workflow profile**: user turns per session; the share of tokens in main-chat new turns, tool-loop continuations, subagents and side calls; a split by delegation hint version with total tokens, dollars at list prices and both per user turn; and the verdict "routing can touch at most X% of your tokens; Y% of that is in subagents". Golden tests over structural copies of the archived real logs (`scripts/report/strip-archive.mjs`) and a synthetic single-turn / long-loop log.
- **Fingerprints for unclassified side calls** (`side_fingerprint`, `src/wire/fingerprint.ts`): structure only (counts, roles, block types, `max_tokens`, thinking, effort, stream, betas) plus at most the 80-character opening of harness text when it matches no user-text heuristic, redacted. `reflex report` section 11 and `reflex report --fingerprints` (JSON lines to send back).
- **`REFLEX_DELEGATE=1`** (opt-in, off by default): the `UserPromptSubmit` hook answers user-typed prompts with a fixed three-line hint (`src/delegate/hint.ts`, `delegate-1`) asking Claude to delegate exploration, multi-file reading, searches and test runs to subagents. Never on slash commands, injected messages, subagent hand-backs or subagent events; any failure is "no hook output". Every decision record carries `delegate_hint`; delivered hints are `record: "delegate_hint"`. Section 8 compares sessions with and without the hint. It can raise total spend (README).
- `reflex doctor` shows whether the delegation hint is on.

## 0.1.3 — 2026-09-19

- Fix: a setting exported as an empty string was treated as set. An empty `ANTHROPIC_BASE_URL` made `reflex doctor` (and every launch) fail with "ANTHROPIC_BASE_URL must be an http(s) URL" instead of using the default upstream, and an empty `REFLEX_UPSTREAM_URL` hid a set `ANTHROPIC_BASE_URL`. Every setting `loadConfig` reads now goes through one helper that treats an empty or whitespace-only value as unset, so the next source or the default applies. `~/.reflex/env` already treated empty process values as unset.

## 0.1.2 — 2026-09-19

- Fix: `reflex report` skips an unterminated last line of `decisions.jsonl` and counts it as skipped.
- `package.json` gains the `repository` field, so the README's relative `docs/` links resolve on a package page.

## 0.1.1 — 2026-09-19

- README rewrite; reference material moved to `docs/reference.md`.
- Test helper reads only complete lines of `decisions.jsonl` (CI race).

## 0.1.0 — 2026-09-19

- First tagged version.
