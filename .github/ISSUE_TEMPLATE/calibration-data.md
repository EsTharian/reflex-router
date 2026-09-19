---
name: Calibration data
about: Attach a structural-only log from `reflex share` so routing thresholds can be calibrated on more than one person's work
title: "calibration data: "
labels: calibration-data
---

Thank you. Routing thresholds are currently tuned on **one person's dogfood log**, which is not enough to tune
anything: that log holds one organic correction in 44 scored windows, and telling the two decision rules apart would
need roughly 430 disagreement windows per arm (`docs/observations.md`). More logs is the only way out.

## Before you attach anything

Run:

```sh
reflex share
```

It writes a structural-only file (hashed ids, tiers, counts, reason codes, token counts, correction *rule ids*) and
prints exactly what is in it. It makes **no network connection** — reflex has no telemetry and no upload path. Read the
file before you attach it:

```sh
head -3 ~/.reflex/reflex-share-*.jsonl
```

If anything in it looks like something you would not want public, **do not attach it** — open an issue describing what
you saw instead. That is a bug in `reflex share` and it is more valuable than the data.

## Please fill in

- **reflex version** (`reflex version`):
- **Claude Code version** (`claude --version`):
- **OS**:
- **Model you request** (your Claude Code model setting):
- **Roughly what the work was** (e.g. "TypeScript web app, mostly refactoring", "data pipelines, lots of failing tests"):
- **Settings you ran with** — especially `REFLEX_MODE`, `REFLEX_DECISION_RULE`, `REFLEX_DELEGATE`, `REFLEX_ESCALATE`,
  `REFLEX_AB` (`reflex doctor` prints all of these and where each came from):

## Most useful of all

If you can run with `REFLEX_AB=0.2` for a while, please say so. That holds a random 20% of routable turns on the model
you asked for, as a control arm. It is the only setting that produces data supporting a **causal** read — every other
comparison in the report is between turns the backend judged easy and turns it did not, which differ in difficulty
before any outcome is measured.

## Attach the file

Drag the `.jsonl` file into this issue.
