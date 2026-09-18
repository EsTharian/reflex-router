# CLAUDE.md

reflex-router: a CLI (`reflex`) that runs the real `claude` behind a loopback proxy and, as decision-making lands, routes work to the cheapest adequate model using a fast decision backend (TypeSafe's Jev). TypeScript (strict), Node 20+, ESM, zero runtime dependencies.

## Commands

```sh
npm test                                   # typecheck + eslint + all offline tests (must pass before every commit)
node scripts/run-tests.mjs <substring>     # run only test files whose path contains <substring>, e.g. `unit/version`
npm run test:live                          # tests needing a real TYPESAFE_API_KEY; skip themselves without one
npm run build                              # tsc -> dist/
npm run gen:versions                       # regenerate src/wire/tested-versions.generated.ts from test/fixtures/claude-code/*
node bin/reflex.js doctor                  # run the built CLI (after `npm run build`)
```

Tests run with `--import tsx` and a preloaded guard (`test/support/no-network.ts`) that throws on any non-loopback connection or DNS lookup, including in forked workers. Never weaken it; use the fake upstream and fake backend in `test/support/`.

## Architecture

```
reflex (launcher process)                        src/launcher/
  front door  127.0.0.1:<port>  owns the port for the whole session; buffers, tries the worker, else forwards to the upstream
  supervisor  keeps one worker alive: liveness probe, restart with backoff, crash loop => passthrough
  claude      spawned with stdio inherited; ANTHROPIC_BASE_URL -> front door; one merged --settings file
worker (child process)                           src/worker/   all routing logic; every failure ends in "forward the original bytes"
src/net/      shared forwarding (header sanitising, streaming relay); the only place that talks HTTP upstream
src/config.ts the ONLY reader of process.env for configuration
src/wire/     the ONLY place that may know Claude Code / Anthropic request shapes (currently just the tested-versions list)
```

Details of what Claude Code sends, with evidence: `docs/wire-format.md`. Redacted real captures: `test/fixtures/claude-code/<version>/`.

## Rules (do not break)

- **Fail-open.** Any error, timeout or unexpected input must end in forwarding the request unchanged, never in a failed Claude Code session. Fallbacks use the model the client asked for, never a fixed tier.
- **Credentials.** Never read, store, log or modify the user's Anthropic credentials; forward auth headers untouched. `TYPESAFE_API_KEY` and all `REFLEX_*`/`TYPESAFE_*` variables are stripped from the environment given to `claude`. Never send the TypeSafe key to Anthropic.
- **Wire format is unstable.** Isolate everything that depends on Claude Code's request/response shapes in `src/wire/`. Treat the Claude Code version as a hint only; verify shape at runtime.
- **Byte-identical passthrough** unless a rewrite is deliberately applied; never re-serialise a body that did not change.
- **Loopback only**, and never edit the user's `~/.claude/settings.json`.
- **No unmeasured claims** (cost, speed, quality) in README or docs.
- **Pricing** lives in `src/pricing.ts` with a "last verified" date and must be checked against Anthropic's pricing page before release (not present yet).
- **Attribution.** Any code adapted from another project is listed in `THIRD_PARTY.md` in the same commit.
- Small, well-described commits; run `npm test` first. Phase/plan documents are local working files (`docs/plan-*.md`, gitignored) and are never committed or referenced from tracked files.

## Fixtures and re-capturing

```sh
node scripts/spike/capture.mjs --out _dumps/<name> -- -p "<prompt>" ...     # dump-only proxy + hooks; raw dumps are gitignored
node scripts/spike/summarize.mjs _dumps/<name>                              # structure only, never full prompts
REFLEX_REDACT_EXTRA="<email>,<username>" node scripts/spike/redact-fixtures.mjs _dumps/<name> --label <name>
npm run gen:versions
```
`redact-fixtures.mjs` masks identifiers everywhere, keeps detection markers, and fails if any original identifier or secret shape remains. Raw dumps contain prompts and account identifiers: never commit them.
