---
name: brainstorm
description: Feature brainstorm for reflex-router. Researches what changed recently (Claude Code, Anthropic API, other routers, papers), reads the repo's own measurements, generates many feature ideas, has TypeSafe Jev judge them and argues with its verdicts, then presents a short, evidence-backed list. Use when the user asks for new feature ideas, "what should reflex do next", a brainstorm, or /brainstorm. Optional argument = focus area (e.g. "cost", "effort", "Laya", "subagents").
argument-hint: "[focus area]"
---

# reflex-router feature brainstorm

Goal: a few ideas the user would actually build, each tied to a dated signal, a place in the code and a way to
measure it. Many ideas go in; few come out. Focus (may be empty): **$ARGUMENTS**

Language: talk to the user in their language (plain Turkish by default: short, few numbers, no jargon).
**Everything sent to Jev is English**, and so are subagent prompts. `jev.ts` refuses text with Turkish letters.

## 0. Setup

Run `date +%F` (today's date anchors all research) and make a work dir in the scratchpad. Say in one line what is
about to happen and roughly how long it takes.

## 1. Ground — three subagents in parallel, one message

Give each the date and the focus. Each returns at most ~400 words, facts only, every item with a source.

- **Repo (Explore, thorough).** Read `CLAUDE.md`, `README.md`, `docs/plan-open-items.md`, the latest sections of
  `docs/observations.md`, `git log --oneline -40`, the setting names in `src/config.ts`. If `dist/` exists, run
  `node bin/reflex.js report --since 14d` and pull the 3 biggest signals (where the cost goes, escalations, what is
  never routed). Return: (a) already built, one line each; (b) open items; (c) measured problems with their numbers;
  (d) data reflex records but never acts on.
- **Web (general-purpose).** What changed in the last ~6 months, each with date + URL + one line on why it matters
  to a local Claude Code router: Claude Code changelog/releases (hooks, settings, subagents, status line, request
  shapes); Anthropic API release notes, models, pricing, effort, caching; what other routers/gateways shipped
  (claude-code-router, LiteLLM, OpenRouter, Portkey, NotDiamond, Martian, RouteLLM, Arch-Router, ...); recent
  routing/cascade/escalation papers; user pain about Claude Code cost, limits and model choice (issues, HN, Reddit).
  Drop undated items; mark anything older than 6 months as "background".
- **TypeSafe (general-purpose).** Read `https://docs.typesafe.ai/llms.txt`, the changelog and the cookbooks
  (append `.md` to page paths). Return System One capabilities and patterns reflex does not use yet (it uses one
  question set per start of work, `src/backend/`), each with one concrete way it could help routing or outcome
  capture.

While they run, read `CLAUDE.md` Rules yourself; they are the filter for step 2.

## 2. Diverge — 15 to 20 idea cards

Cover every lane at least once: cost, routing quality/safety, transparency/UX, new Jev or Laya judgments, new Claude
Code surfaces (hooks, status line, subagents), measurement/calibration, and 2-3 wild cards. Each card, in English:

```json
{ "title": "...", "pitch": "one sentence", "problem": "...",
  "evidence": "dated sources / measured numbers from step 1, or 'none'",
  "mechanism": "which module changes and how (src/wire, src/worker, ...)",
  "fail_open": "what happens when it breaks", "measure": "how reflex report or a test would show it works",
  "size": "S | M | L" }
```

Drop on the spot (and list in one line why): anything that needs telemetry or uploads, touches credentials, edits
`~/.claude/settings.json`, re-serialises unchanged bodies, leaves loopback, or lets an outcome lower a tier or change
prompt text. A good card names a real signal; "add a dashboard" with no evidence is not an idea.

## 3. Jev panel

Write `requests.json` (one request per card) and run:

```sh
node --import tsx .claude/skills/brainstorm/jev.ts <workdir>/requests.json
```

State per request: `{ "project": { "summary", "rules", "already_built", "open_items" }, "idea": <card> }`; keep
`project` short and identical across requests (rules in one line each). Without `questions` it asks `panel.json`:
`value` (0-4), `evidence` (0-3), `novelty` (0-3) and three yes-probabilities: `rule_conflict`, `duplicate`,
`measurable`. Jev returns judgments, not arguments: treat it as a calibrated second reader, not an oracle.

Policy (yours, keep it explicit): cut `rule_conflict > 0.5` or `duplicate > 0.6`; rank the rest by
`value + evidence`, use `novelty` to pick the wild cards; `measurable < 0.5` means the card needs a better
`measure`, not a cut.

## 4. Argue with Jev — at most two rounds

Before looking at the numbers, write your own top 5. Then compare:

- **Disagreement** (your top 5 vs. Jev's low `value`, or the reverse): say which of you is missing something. If the
  card was vague or lacked evidence Jev could not see, fix the card with *real* content and re-ask that card once.
  Never reword only to lift a score; show before/after numbers in the notes.
- **Assumption check.** For each finalist, write the 1-2 assumptions it stands on as `noul` questions over the same
  state (e.g. "Would a typical user of `project` turn on `idea` if it were opt-in?") and ask them in one batch.
- **Head to head.** One `choice` question over the finalists ("Which one should `project` build next?", criteria =
  title -> pitch), asked twice with the options in reverse order. A pick that flips is a tie; say so.
- **Jev-powered ideas.** If an idea adds a new judgment for Jev/Laya inside reflex, prototype it now: the proposed
  question plus 4-6 made-up English states, half that should say yes and half no. If the answers do not separate
  (gap under ~0.4), report that plainly.

Custom requests pass their own `questions` object (same wire format as `panel.json`, see `src/types.ts`).

## 5. Feasibility peek — subagents in parallel

For the top 3, one Explore agent each: which files change, rough diff size, which Rule is closest to being bent,
what a first test would assert. ~200 words each.

## 6. Present

Full notes (all cards, all Jev numbers, disagreements, rejected list) go to `docs/plan-ideas-<date>.md`
(gitignored, never committed). In chat, plain language:

- **Top 5-7**, each: what it is (one sentence), why now (the dated source), where it lives in the code, how we
  would know it works, size, and Jev's view in words ("Jev thinks it's valuable but the evidence is thin").
- **Wild cards**: 2-3, one line each.
- **Where Jev and I disagreed**: one line each, who you side with and why.
- Ask which to take; offer to add the chosen ones to `docs/plan-open-items.md`.

No cost, speed or quality claims beyond what a source or a measurement says (CLAUDE.md "No unmeasured claims").
