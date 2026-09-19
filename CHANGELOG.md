# Changelog

None of these versions has been published to a registry.

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
