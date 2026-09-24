---
name: brainstorm
description: Feature brainstorm for reflex-router. Starts from what Claude Code users struggle with and what changed recently (Claude Code, Anthropic API, other tools, papers), checks every idea against the code so nothing already built comes back, has TypeSafe Jev judge them and argues with its verdicts, then presents a short list of new capabilities (plus a few tunings). Use when the user asks for new feature ideas, "what should reflex do next", a brainstorm, or /brainstorm. Optional argument = focus area (e.g. "cost", "effort", "subagents", "visibility").
argument-hint: "[focus area]"
---

# reflex-router feature brainstorm

Goal: a few **features** the user would actually build, each tied to a dated signal, a place in the code and a way to
measure it. Many ideas go in; few come out. Focus (may be empty): **$ARGUMENTS**

**What counts as a feature.** reflex is a process that sits between the user and Claude Code: it sees every request
and response, answers every hook, owns the status line and ships a CLI. A feature is something a user would notice
and want that reflex does not do at all today, and it may use that position for anything the Rules allow, not only
for picking a model. Adjusting a knob reflex already has (a threshold, a default, a guard, a label) is a **tune**.
Tunes are welcome but they are not the output; a run that ends with only tunes has failed and must say so.

Why this rule exists (2026-09-24 run): cards grew from reflex's own `report` numbers, so every card tuned an existing
mechanism; the three finalists turned out to be already built, and one "bug" a subagent reported did not exist.

Language: talk to the user in their language (plain Turkish by default: short, few numbers, no jargon).
**Everything sent to Jev is English**, and so are subagent prompts. `jev.ts` refuses text with Turkish letters.

## 0. Setup

Run `date +%F` (today's date anchors all research) and make a work dir in the scratchpad. Say in one line what is
about to happen and roughly how long it takes.

## 1. Ground — four subagents in parallel, one message

Give each the date and the focus. Each returns at most ~400 words, facts only, every item with a source.

- **Users (general-purpose).** What people using Claude Code struggle with or ask for, not what reflex measures. Use
  `gh search issues --repo anthropics/claude-code --sort reactions --limit 30 <term>` for terms such as cost, usage
  limit, rate limit, model, opus, subagent, context, compact, status line, session, hooks; plus HN and Reddit
  (r/ClaudeAI, r/ClaudeCode) threads. Also: what features competing tools offer *their users* (claude-code-router,
  ccusage, Cursor, Aider, Cline/Roo, Copilot, LiteLLM/Portkey dashboards), as features, not release notes. Return at
  least 10 dated items, each: the user's job in one line ("when I ..., I want ..."), how many people it touches
  (reactions, upvotes), URL. Fewer than 10: say where it searched and what came up empty.
- **Changes (general-purpose).** What changed in the last ~6 months, each with date + URL + one line on what it
  newly makes possible for a tool that sits in front of Claude Code: Claude Code changelog (hooks, settings,
  subagents, status line, sessions, request shapes); Anthropic API release notes (models, pricing, effort, caching);
  routing/cascade papers. Drop undated items; mark anything older than 6 months as "background".
- **Repo (Explore, thorough).** Read `CLAUDE.md`, `README.md`, `docs/plan-open-items.md`, the latest sections of
  `docs/observations.md`, `git log --oneline -40`, `src/config.ts`. If `dist/` exists, run
  `node bin/reflex.js report --since 14d`. Return: (a) an **inventory**: every setting and command, one line each on
  what it does and what it deliberately does not cover, with file:line (step 2b checks cards against it);
  (b) open items; (c) the 3 biggest measured problems with numbers; (d) data reflex records but never shows or uses.
- **TypeSafe (general-purpose).** Read `https://docs.typesafe.ai/llms.txt`, the changelog and the cookbooks
  (append `.md` to page paths). Return System One capabilities and patterns reflex does not use yet (it uses one
  question set per start of work, `src/backend/`), each with one concrete thing it would let reflex do for a user,
  not only how it would tune routing.

While they run, read `CLAUDE.md` Rules yourself; they are the filter for step 2.

## 2. Diverge — 15 to 20 idea cards

At least 10 cards are `new` and at most 6 are `tune` (see "What counts as a feature"). A `new` card starts from a
user job found in step 1 (Users or Changes), not from a `report` number; a number may support it. Lanes to cover
across the `new` cards: something the user sees (status line, CLI, hook messages), something the user can now do
that they cannot today (sessions, limits, subagents, handoff, review), a new judgment for Jev, a use of a recent
Claude Code or API change, and 2-3 wild cards. Each card, in English:

```json
{ "kind": "new | tune", "title": "...", "user_job": "when I ..., I want ... (the source's words, not yours)",
  "pitch": "one sentence", "problem": "...",
  "evidence": "dated sources / measured numbers from step 1, or 'none'",
  "mechanism": "which module changes and how (src/wire, src/worker, ...)",
  "fail_open": "what happens when it breaks", "measure": "how reflex report or a test would show it works",
  "size": "S | M | L" }
```

Drop on the spot (and list in one line why): anything that needs telemetry or uploads, touches credentials, edits
`~/.claude/settings.json`, re-serialises unchanged bodies, leaves loopback, or lets an outcome lower a tier or change
prompt text. A good card names a real signal; "add a dashboard" with no evidence is not an idea.

## 2b. Already built? — one Explore agent, before Jev

Jev cannot see the code, so its `duplicate` answer is only as good as the list you give it. Send all cards (title,
kind, mechanism) and the step 1 inventory to one Explore agent: per card `built | partly | not`, with file:line. Drop
`built`; rewrite `partly` to the missing part only (and re-label it `tune` if that part is a knob). Build the Jev
`already_built` list from the inventory, not from memory. If fewer than 6 `new` cards survive, go back to step 2
once with the Users findings you did not use.

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

Before looking at the numbers, write your own top 5, at least 3 of them `new`. Then compare:

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

Before anything from here reaches the user, read the lines a subagent cites for every "gap", "bug" or "not covered"
claim yourself. An unchecked claim is not presented.

## 6. Present

Full notes (all cards, all Jev numbers, disagreements, rejected list) go to `docs/plan-ideas-<date>.md`
(gitignored, never committed). In chat, plain language:

- **Top 5-7**, `new` first, each: what it is (one sentence), whose problem it solves (the user job and its source),
  why now (the dated source), where it lives in the code, how we would know it works, size, and Jev's view in words
  ("Jev thinks it's valuable but the evidence is thin").
- **Tunes**: at most 3, one line each, clearly labelled as adjustments to what exists.
- If no `new` card survived, say so first and why (no user evidence, all built, all rule conflicts); do not fill
  the top list with tunes.
- **Wild cards**: 2-3, one line each.
- **Where Jev and I disagreed**: one line each, who you side with and why.
- Ask which to take; offer to add the chosen ones to `docs/plan-open-items.md`.

No cost, speed or quality claims beyond what a source or a measurement says (CLAUDE.md "No unmeasured claims").
