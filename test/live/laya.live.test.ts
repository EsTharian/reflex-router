// Live comparison of the decision backends on the labelled reasoning set (test/live/reasoning-set.ts): a real
// laya-serve started exactly as the launcher starts it (one run per checkpoint), and TypeSafe Jev when a key is
// available (process environment or ~/.reflex/env). Same state, same questions as the product. Skips without laya-serve.
// REPORTS results (stdout and _dumps/live/*.json); it fails only on calls that fail or answers that are malformed.
// Cost: 30 Jev calls when a key is present; Laya runs locally.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { JevBackend } from "../../src/backend/jev.js";
import { LAYA_MODELS, loadConfig, type Config, type LayaModel, type Tier } from "../../src/config.js";
import { mergeEnvFile } from "../../src/env-file.js";
import { realResolveIO, resolveBin } from "../../src/launcher/claude-bin.js";
import { sanitizedEnv } from "../../src/launcher/launch.js";
import { startLaya } from "../../src/launcher/laya.js";
import { buildQuestions, judge } from "../../src/policy.js";
import { buildState } from "../../src/privacy/state.js";
import { percentile } from "../../src/report/format.js";
import { tierRank } from "../../src/tiers.js";
import { REASONING_SET } from "./reasoning-set.js";

const layaBin = resolveBin("laya-serve", process.env["REFLEX_LAYA_BIN"]?.trim() || undefined, realResolveIO(process.env));
const skip = layaBin ? false : "laya-serve is not on PATH";
const jevKey = mergeEnvFile(process.env).env["TYPESAFE_API_KEY"]?.trim();

const loaded = loadConfig({ REFLEX_ALLOW_FABLE: "" });
assert.ok(loaded.ok);
const cfg: Config = loaded.config;
const questions = buildQuestions(cfg);
const stateOf = (task: string) => buildState({ kind: "main", task, previousAssistantText: null, requestedModel: cfg.models.opus }, cfg).state;
const signal = (): { signal: AbortSignal } => ({ signal: new AbortController().signal });

interface Row {
  id: string;
  cell: string;
  label: Tier;
  pick: Tier;
  argmax: string;
  pOpus: number;
  demand: number | undefined;
  latencyMs: number;
  tokensIn: number | null;
}

async function run(backend: JevBackend): Promise<Row[]> {
  const rows: Row[] = [];
  for (const p of REASONING_SET) {
    const d = await backend.decide(stateOf(p.task), questions, signal());
    const j = judge(d, cfg);
    assert.ok(j.ok, `${p.id}: ${j.ok ? "" : j.error}`);
    const t = d.answers["tier"];
    assert.ok(t?.type === "choice");
    rows.push({ id: p.id, cell: p.cell, label: p.label, pick: j.judgement.tier.value, argmax: t.choice, pOpus: t.probabilities["opus"] ?? 0, demand: j.judgement.vetoes["reasoning_demand"], latencyMs: d.latencyMs, tokensIn: d.tokensIn });
  }
  return rows;
}

function summary(rows: Row[]) {
  const s = (r: Row[]) => ({
    n: r.length,
    exact: r.filter((x) => x.pick === x.label).length,
    under: r.filter((x) => tierRank(x.pick) < tierRank(x.label)).length,
    over: r.filter((x) => tierRank(x.pick) > tierRank(x.label)).length,
  });
  const cells = ["short-hard", "long-easy", "short-easy", "long-hard", "mid"];
  const picks = Object.fromEntries(["haiku", "sonnet", "opus"].map((t) => [t, rows.filter((r) => r.pick === t).length]));
  const argmax = Object.fromEntries(["haiku", "sonnet", "opus"].map((t) => [t, rows.filter((r) => r.argmax === t).length]));
  // Does P(opus) separate the opus-labelled prompts from the haiku-labelled ones at all? (AUC, 0.5 = chance)
  const pos = rows.filter((r) => r.label === "opus").map((r) => r.pOpus);
  const neg = rows.filter((r) => r.label === "haiku").map((r) => r.pOpus);
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  const lat = rows.map((r) => r.latencyMs);
  const toks = rows.map((r) => r.tokensIn).filter((t): t is number => t !== null);
  return {
    all: s(rows),
    ...Object.fromEntries(cells.map((c) => [c, s(rows.filter((r) => r.cell === c))])),
    picks,
    argmax,
    aucOpusVsHaiku: pos.length && neg.length ? Math.round((wins / (pos.length * neg.length)) * 1000) / 1000 : null,
    latencyMs: { p50: percentile(lat, 50), p95: percentile(lat, 95), max: Math.max(...lat) },
    tokensIn: toks.length ? { max: Math.max(...toks), over512: toks.filter((t) => t > 512).length } : null,
  };
}

function save(name: string, data: unknown): void {
  const dir = path.join("_dumps", "live");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`# results written to ${file}`);
}

describe("live backend comparison on the labelled reasoning set", { skip }, () => {
  it("Laya (each checkpoint) and Jev: mass pick vs the author's label", { timeout: 30 * 60_000 }, async () => {
    const results: Record<string, { summary: ReturnType<typeof summary>; rows: Row[]; readyMs?: number }> = {};
    for (const model of LAYA_MODELS as readonly LayaModel[]) {
      const t0 = Date.now();
      const laya = await startLaya({ bin: layaBin!, env: sanitizedEnv(process.env), model, readyTimeoutMs: 300_000, logFile: null });
      try {
        assert.equal(await laya.ready, true, `laya-serve (${model}) did not load`);
        const readyMs = Date.now() - t0;
        const b = new JevBackend({ id: "laya", baseUrl: laya.baseUrl, apiKey: laya.apiKey, model, deadlineMs: 30_000 });
        await b.decide(stateOf("warm-up"), questions, signal()); // first forward pass pays one-off setup
        const rows = await run(b);
        b.close();
        results[`laya:${model}`] = { summary: summary(rows), rows, readyMs };
        console.log(`# laya:${model} ready in ${readyMs} ms: ${JSON.stringify(results[`laya:${model}`]!.summary)}`);
      } finally {
        await laya.stop();
      }
    }
    if (jevKey) {
      const b = new JevBackend({ baseUrl: cfg.jevBaseUrl, apiKey: jevKey, deadlineMs: 10_000 });
      const rows = await run(b);
      b.close();
      results["jev"] = { summary: summary(rows), rows };
      console.log(`# jev: ${JSON.stringify(results["jev"].summary)}`);
    } else console.log("# jev: skipped (no TYPESAFE_API_KEY)");
    save("backend-comparison", { labelsAreAuthorJudgement: true, rule: cfg.decisionRule, massEps: cfg.massEps, machine: `${process.platform}/${process.arch}`, results });
  });
});
