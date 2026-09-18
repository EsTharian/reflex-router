# Shadow-mode observations

Measured results from running reflex in `shadow` mode on real sessions. Each entry states its conditions and sample size. These are observations, not general claims: one session is not a benchmark.

## 2026-09-19 — first dogfood session

**Setup.** One interactive Claude Code 2.1.277 session (Sonnet 5 requested), reflex at commit `0e2f76a` (the M2 build), shadow mode, Jev `jev-latest`, run from Turkey. Jev client at that time used global `fetch` (no persistent connection; see Latency).

**Classification.** 61 records: 12 `new` (11 main chat, 1 subagent), 24 `continuation`, 25 `side` (`no_tools` 13, `suggestion` 8, `agent_summary` 1, `compaction` 1, `cross_session` 1, `notification` 1). Zero `unclassified`, zero shape degrades, zero backend errors. `/compact` was classified as `side`/`compaction`.

**Reasoning, not length.** One main-chat turn was a hard question that ended with "answer in one sentence", i.e. it asked for a very short reply. Jev picked `opus` for it with `reasoning_demand` 3.24 (of 0–4). The tier question tells the backend to judge the reasoning a task demands and not the length of the message or reply (`src/policy.ts`), so this is our own first confirmation, on one prompt, of the "reasoning not length" behaviour previously reported for jev-router. The planned labelled comparison (length-framed vs reasoning-framed instructions) is still needed before this is more than one data point.

**Confidence.** 5 of 12 decisions stopped at `low_confidence` (choice confidence below the provisional 0.70 floor), including the only subagent turn (`sonnet`, confidence 0.32). Confidence is a spread statistic over the whole distribution, not the top probability, so a clear top option can still come with low confidence. Thresholds are unchanged; this is input for Phase 2 calibration.

**Latency.** Jev decision latency p50 823 ms, p95 1136 ms (n = 12), measured with a fresh TCP+TLS connection per decision (global `fetch` drops idle connections after about 4 s). Shadow mode keeps this off the critical path. The client now holds a keep-alive connection and records `decision.connection` (`new`/`reused`) so the effect can be measured on the next session.
