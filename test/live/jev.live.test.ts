// Live tests against the real TypeSafe Jev endpoint. Run with `npm run test:live`; they skip themselves without a
// TYPESAFE_API_KEY. Cost: about 90 decision calls in total (1 round trip, 13 latency samples, 30 prompts x 2 framings).
// The latency and reasoning-vs-length tests REPORT results (stdout and _dumps/live/*.json); they do not fail on what the
// numbers turn out to be, only on calls that fail or answers that are malformed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig, type Config, type Tier } from "../../src/config.js";
import { JevBackend } from "../../src/backend/jev.js";
import { buildQuestions, judge, massPick, offeredTiers, QUESTIONS } from "../../src/policy.js";
import { buildState } from "../../src/privacy/state.js";
import { percentile } from "../../src/report/format.js";
import { tierRank } from "../../src/tiers.js";
import type { QuestionSet } from "../../src/types.js";
import { REASONING_SET, type LabelledPrompt } from "./reasoning-set.js";

const key = process.env["TYPESAFE_API_KEY"]?.trim();
const skip = key ? false : "TYPESAFE_API_KEY is not set";
const DEADLINE_MS = 10_000; // generous: these tests measure, the product's own deadline is REFLEX_JEV_DEADLINE_MS

const loaded = loadConfig({ REFLEX_ALLOW_FABLE: "" });
assert.ok(loaded.ok);
const cfg: Config = loaded.config;
const backend = (): JevBackend => new JevBackend({ baseUrl: process.env["REFLEX_JEV_BASE_URL"]?.trim() || cfg.jevBaseUrl, apiKey: key ?? "", deadlineMs: DEADLINE_MS });
const stateOf = (task: string) => buildState({ kind: "main", task, previousAssistantText: null, requestedModel: cfg.models.opus }, cfg).state;
const signal = (): { signal: AbortSignal } => ({ signal: new AbortController().signal });

function save(name: string, data: unknown): void {
  const dir = path.join("_dumps", "live");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`# results written to ${file}`);
}

describe("live Jev", { skip }, () => {
  it("response shape round trip: the product's own questions come back valid and readable by the policy", async () => {
    const b = backend();
    try {
      const d = await b.decide(stateOf("Rename the variable tmp to buffer in utils.ts."), buildQuestions(cfg), signal());
      assert.deepEqual(Object.keys(d.answers).sort(), Object.keys(QUESTIONS).sort());
      const j = judge(d, cfg);
      assert.ok(j.ok, j.ok ? "" : j.error);
      assert.ok(offeredTiers(cfg).includes(j.judgement.tier.value));
      const p = j.judgement.tier.probabilities;
      assert.ok(Math.abs(Object.values(p).reduce((a, x) => a + x, 0) - 1) < 0.02, "tier probabilities sum to 1");
      const demand = j.judgement.vetoes["reasoning_demand"];
      assert.ok(demand !== undefined && demand >= 0 && demand <= 4, `reasoning_demand in 0..4, got ${String(demand)}`);
      assert.ok(d.latencyMs > 0 && typeof d.backendModel === "string" && d.backendModel.length > 0);
      assert.ok(d.tokensIn === null || d.tokensIn > 0);
      assert.ok(d.connection === "new" || d.connection === "reused");
      console.log(`# shape ok: model ${d.backendModel}, tier ${j.judgement.tier.value} ${JSON.stringify(p)}, reasoning_demand ${String(demand)}, ${d.latencyMs} ms, tokensIn ${String(d.tokensIn)}`);
    } finally {
      b.close();
    }
  });

  it("latency sample: a warmed keep-alive connection is reused across decisions (and across a 6 s idle gap)", async () => {
    const b = backend();
    const tasks = ["List the files in src/.", "Where is loadConfig defined?", "Run the tests.", "Rename foo to bar in a.ts.", "Print the git branch.", "Fix the failing test in policy.test.ts.", "Summarise the supervisor.", "Add a --json flag to report.", "Why does the lock deadlock under load?", "Count the lines in README.md.", "Explain the guard.", "Add a trailing newline."];
    const samples: { latencyMs: number; connection: string | null; afterIdle: boolean }[] = [];
    try {
      await b.warm();
      for (const [i, t] of tasks.entries()) {
        const afterIdle = i === 6;
        if (afterIdle) await new Promise((r) => setTimeout(r, 6000));
        const d = await b.decide(stateOf(t), buildQuestions(cfg), signal());
        samples.push({ latencyMs: d.latencyMs, connection: d.connection, afterIdle });
      }
    } finally {
      b.close();
    }
    const by = (c: string): number[] => samples.filter((s) => s.connection === c).map((s) => s.latencyMs);
    const summary = { n: samples.length, new: { n: by("new").length, p50: percentile(by("new"), 50), p95: percentile(by("new"), 95) }, reused: { n: by("reused").length, p50: percentile(by("reused"), 50), p95: percentile(by("reused"), 95) }, afterIdle: samples.find((s) => s.afterIdle), samples };
    console.log(`# latency: ${JSON.stringify({ ...summary, samples: undefined })}`);
    save("latency", summary);
    assert.equal(samples.length, tasks.length);
    assert.ok(by("reused").length >= 1, "at least one decision reused the connection");
  });

  it("reasoning vs length: does the tier follow the reasoning demanded or the size of the message?", async () => {
    const b = backend();
    const reasoning = buildQuestions(cfg);
    // Same options and criteria; only the instruction to the judge changes.
    const lengthFramed: QuestionSet = {
      tier: {
        ...reasoning["tier"]!,
        instructions: {
          ...(reasoning["tier"]!.instructions as object),
          focus: "Judge how big the task is: the length of the message, the length of the expected reply, and the number of files or items involved. More text and more items mean a bigger task.",
        },
      },
    };
    type Row = { id: string; cell: string; label: Tier; framing: string; mass: Tier; argmax: Tier; probs: Record<string, number> };
    const rows: Row[] = [];
    const ask = async (p: LabelledPrompt, framing: string, questions: QuestionSet): Promise<void> => {
      const d = await b.decide(stateOf(p.task), questions, signal());
      const a = d.answers["tier"];
      assert.ok(a && a.type === "choice", `${p.id}/${framing}: a choice answer`);
      rows.push({ id: p.id, cell: p.cell, label: p.label, framing, mass: massPick(a.probabilities, offeredTiers(cfg), cfg.massEps).value, argmax: a.choice as Tier, probs: a.probabilities });
    };
    try {
      for (const p of REASONING_SET) {
        await ask(p, "reasoning", { tier: reasoning["tier"]! });
        await ask(p, "length", lengthFramed);
      }
    } finally {
      b.close();
    }
    assert.equal(rows.length, REASONING_SET.length * 2);

    const score = (framing: string, cells?: readonly string[]) => {
      const r = rows.filter((x) => x.framing === framing && (cells === undefined || cells.includes(x.cell)));
      const exact = r.filter((x) => x.mass === x.label).length;
      const under = r.filter((x) => tierRank(x.mass) < tierRank(x.label)).length;
      const over = r.filter((x) => tierRank(x.mass) > tierRank(x.label)).length;
      return { n: r.length, exact, under, over };
    };
    const report = Object.fromEntries(["reasoning", "length"].map((f) => [f, { all: score(f), discordant: score(f, ["short-hard", "long-easy"]), ...Object.fromEntries(["short-hard", "long-easy", "short-easy", "long-hard", "mid"].map((c) => [c, score(f, [c])])) }]));
    console.log("# reasoning-vs-length (mass pick vs the author's label; under = cheaper than labelled, over = dearer):");
    console.log(JSON.stringify(report, null, 1));
    save("reasoning-vs-length", { labelsAreAuthorJudgement: true, massEps: cfg.massEps, report, rows });
    // Not asserted: which framing wins. That is the finding, and it goes in docs/observations.md whichever way it falls.
  });
});
