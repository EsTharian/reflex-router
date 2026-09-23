// Scores a fine-tuned Laya checkpoint against Jev (the teacher) and against the shipped calibrated Laya
// (REFLEX_LAYA_MODEL with its head), on the prompts you typed in past sessions (history.ts). The fine-tuned checkpoint
// is asked only the product's questions, uncalibrated, through laya-serve-checkpoint.sh. The prompts go to Jev and to
// local laya-serve processes and stay in memory; nothing is written, only the summary is printed. They DO go to
// TypeSafe Jev, so run this only with the owner's consent.
//
//   node --import tsx scripts/calibrate/eval-checkpoint.ts <checkpoint-dir> [--exclude <substring>]...
import path from "node:path";
import { JevBackend } from "../../src/backend/jev.js";
import { LAYA_CALIBRATIONS } from "../../src/backend/laya-calibration.generated.js";
import type { LayaCalibration } from "../../src/backend/laya-calibration.js";
import { LayaBackend } from "../../src/backend/laya.js";
import { loadConfig, type Config } from "../../src/config.js";
import { mergeEnvFile } from "../../src/env-file.js";
import { realResolveIO, resolveBin, type ResolvedBin } from "../../src/launcher/claude-bin.js";
import { sanitizedEnv } from "../../src/launcher/launch.js";
import { startLaya } from "../../src/launcher/laya.js";
import { buildQuestions } from "../../src/policy.js";
import type { DecisionBackend } from "../../src/backend/types.js";
import type { HarvestItem } from "./harvest.js";
import { historyItems } from "./history.js";
import { jevTarget, pickMargin, score, withOpusMargin, type Target } from "./lib.js";

const args = process.argv.slice(2);
const checkpoint = args[0];
if (!checkpoint || checkpoint.startsWith("--")) throw new Error("usage: eval-checkpoint.ts <checkpoint-dir> [--exclude <substring>]...");
const exclude = args.flatMap((a, i) => (a === "--exclude" && args[i + 1] !== undefined ? [args[i + 1]!] : []));
const loaded = loadConfig({});
if (!loaded.ok) throw new Error(loaded.errors.join("; "));
const cfg = loaded.config;
const env = mergeEnvFile(process.env).env;
const key = env["TYPESAFE_API_KEY"]?.trim();
if (!key) throw new Error("TYPESAFE_API_KEY is needed (the teacher is Jev)");
const questions = buildQuestions(cfg);
const signal = { signal: new AbortController().signal };

/** Each item's answer as a Target (null where the backend failed), and the latencies of the answers. */
async function ask(name: string, backend: DecisionBackend, items: readonly HarvestItem[]): Promise<{ targets: (Target | null)[]; latencies: number[] }> {
  const targets: (Target | null)[] = [];
  const latencies: number[] = [];
  for (const [i, it] of items.entries()) {
    if (i % 25 === 0) process.stderr.write(`${name}: ${i}/${items.length}\n`);
    try {
      const d = await backend.decide(it.state, questions, signal);
      targets.push(jevTarget(d.answers));
      latencies.push(d.latencyMs);
    } catch {
      targets.push(null);
    }
  }
  return { targets, latencies };
}

async function askLaya(name: string, bin: ResolvedBin, model: Config["layaModel"], cal: LayaCalibration | undefined, extraEnv: NodeJS.ProcessEnv, items: readonly HarvestItem[]) {
  process.stderr.write(`${name}: loading laya-serve\n`);
  const server = await startLaya({ bin, env: { ...sanitizedEnv(process.env), ...extraEnv }, model, readyTimeoutMs: 300_000, logFile: null });
  try {
    if (!(await server.ready)) throw new Error(`laya-serve (${model}) did not load`);
    const laya = new LayaBackend(new JevBackend({ id: "laya", baseUrl: server.baseUrl, apiKey: server.apiKey, model, deadlineMs: 60_000 }), cal);
    try {
      return await ask(name, laya, items);
    } finally {
      laya.close();
    }
  } finally {
    await server.stop();
  }
}

const { items, transcripts } = historyItems(cfg, exclude);
console.log(`${items.length} typed prompts from ${transcripts} transcripts`);

const jev = new JevBackend({ baseUrl: cfg.jevBaseUrl, apiKey: key, deadlineMs: 15_000 });
const teacher = await ask("jev", jev, items);
jev.close();

const layaServe = resolveBin("laya-serve", env["REFLEX_LAYA_BIN"]?.trim() || undefined, realResolveIO(process.env));
if (!layaServe) throw new Error("laya-serve is not on PATH");
const wrapper = { path: path.join(import.meta.dirname, "laya-serve-checkpoint.sh"), needsShell: false };
const shipped = `shipped ${cfg.layaModel} + ${LAYA_CALIBRATIONS[cfg.layaModel]?.version ?? "no head"}`;
const tuned = `fine-tuned ${path.basename(path.resolve(checkpoint))}`;
const runs = {
  [shipped]: await askLaya(shipped, layaServe, cfg.layaModel, LAYA_CALIBRATIONS[cfg.layaModel], {}, items),
  [tuned]: await askLaya(tuned, wrapper, "typed-decisions", undefined, { LAYA_CHECKPOINT: path.resolve(checkpoint) }, items),
};

// Only items every backend answered, so the rows compare the same prompts.
const kept = items.map((_, i) => i).filter((i) => teacher.targets[i] && Object.values(runs).every((r) => r.targets[i]));
const pct = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)] ?? NaN;
console.log(`scored on ${kept.length}/${items.length} (every backend answered); Jev ${teacher.targets.filter(Boolean).length}`);
for (const [name, r] of Object.entries(runs)) {
  const s = score(kept.map((i) => ({ ...r.targets[i]!, t: teacher.targets[i]! })), cfg.massEps);
  console.log(`\n${name}: answered ${r.targets.filter(Boolean).length}/${items.length}, latency p50/p95 ${pct(r.latencies, 0.5)}/${pct(r.latencies, 0.95)} ms`);
  console.log(JSON.stringify(s));
}

// The fine-tuned checkpoint has no head, so no opus margin yet. Pick one as fit.ts does (the smallest whose plans are
// cheaper than Jev's at most 3% of the time) on one half of the transcripts and score it on the other half, both ways:
// the margin is never scored on the prompts it was tuned on.
const half = (i: number): number => Number(items[i]!.group.slice(1)) % 2;
const tunedTargets = runs[tuned]!.targets;
const pairs = (idx: readonly number[], delta = 0) => idx.map((i) => ({ p: withOpusMargin(tunedTargets[i]!.p, delta), demand: tunedTargets[i]!.demand, t: teacher.targets[i]! }));
const halves = [0, 1].map((h) => kept.filter((i) => half(i) === h));
const margins = halves.map((idx) => pickMargin(pairs(idx), cfg.massEps, 0.03));
const heldOut = [0, 1].flatMap((h) => pairs(halves[1 - h]!, margins[h]));
console.log(`\n${tuned} + opus margin tuned on the other half (margins ${margins.join(" / ")}; halves ${halves[0]!.length} / ${halves[1]!.length}):`);
console.log(JSON.stringify(score(heldOut, cfg.massEps)));
