// Fits the Laya calibration head from recorded Jev/Laya pairs and reports cross-validated results.
//
//   node --import tsx scripts/calibrate/fit.ts [--model typed-decisions] [--eps 0.1] [--group record|session] [--write] <file.jsonl>...
//
// --group: what cross-validation keeps together. `session` is the honest choice once there are many sessions; with
// one or two long sessions it leaves nothing to validate on, so `record` (each decision on its own) is the default and
// is optimistic by however much decisions of one session resemble each other.
//
// Inputs: decisions.jsonl files from sessions run with REFLEX_COMPARE=laya (a decision record with a `compare` block
// holds Laya's feature vector next to Jev's answer), and/or harvest-*.ts output. Only numbers are read.
// --write adds (or replaces) the checkpoint's entry in src/backend/laya-calibration.generated.ts.
import fs from "node:fs";
import { FEATURE_VERSION, type LayaCalibration } from "../../src/backend/laya-calibration.js";
import { LAYA_CALIBRATIONS } from "../../src/backend/laya-calibration.generated.js";
import { LAYA_MODELS, type LayaModel } from "../../src/config.js";
import { calibrationOf, crossValidate, rawOf, score, targetOf, type Sample, type Scores } from "./lib.js";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const model = (opt("--model") ?? "typed-decisions") as LayaModel;
if (!LAYA_MODELS.includes(model)) throw new Error(`--model must be one of ${LAYA_MODELS.join(", ")}`);
const eps = Number(opt("--eps") ?? 0.1);
const groupBy = opt("--group") ?? "record";
const write = args.includes("--write");
const files = args.filter((a) => a !== "--write");
if (files.length === 0) throw new Error("give at least one .jsonl file");

type Rec = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const vec = (v: unknown): number[] | null => (Array.isArray(v) && v.length > 0 && v.every((x) => num(x) !== null) ? (v as number[]) : null);

const samples: Sample[] = [];
const bySource: Record<string, number> = {};
for (const file of files) {
  for (const [i, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
    let r: Rec;
    try {
      r = JSON.parse(line) as Rec;
    } catch {
      continue;
    }
    if (r["feature_version"] !== FEATURE_VERSION && (r["compare"] as Rec | undefined)?.["feature_version"] !== FEATURE_VERSION) continue;
    let x: number[] | null = null;
    let t = null;
    let group = "";
    let source = "";
    if (typeof r["source"] === "string") {
      x = vec(r[`x_${model}`]);
      const j = r["jev"] as { p?: Record<string, number>; demand?: number } | undefined;
      t = j?.p && num(j.demand) !== null ? targetOf(j.p, j.demand!) : null;
      group = typeof r["group"] === "string" ? r["group"] : `${file}:${i}`;
      source = `${r["source"]}${typeof r["kind"] === "string" ? `:${r["kind"]}` : ""}`;
    } else if (r["record"] === "decision") {
      const c = r["compare"] as Rec | undefined;
      const d = r["decision"] as { picks?: { tier?: { probabilities?: Record<string, number> } }; vetoes?: Record<string, number> } | null;
      if (c?.["model"] !== model || !d) continue;
      x = vec(c["x"]);
      const probs = d.picks?.tier?.probabilities;
      const demand = num(d.vetoes?.["reasoning_demand"]);
      t = probs && demand !== null ? targetOf(probs, demand) : null;
      group = groupBy === "session" ? String(r["session"]) : String(r["id"]);
      source = `session:${String(r["kind"])}`;
    }
    if (x === null || t === null) continue;
    samples.push({ x, t, group });
    bySource[source] = (bySource[source] ?? 0) + 1;
  }
}
console.log(`${samples.length} samples for ${model} (${FEATURE_VERSION}): ${JSON.stringify(bySource)}; ${new Set(samples.map((s) => s.group)).size} groups`);
if (samples.length < 20) throw new Error("too few samples to fit");

const fmt = (s: Scores): string =>
  `pick agree ${s.agree}/${s.n} (${((100 * s.agree) / s.n).toFixed(1)}%) under ${s.under} over ${s.over} | PLAN agree ${s.plan.agree} under ${s.plan.under} over ${s.plan.over} picks ${JSON.stringify(s.plan.picks)} recall ${JSON.stringify(s.recall)} | xent ${s.xent.toFixed(3)} demand MAE ${s.demandMae.toFixed(2)}`;
const jevSelf = score(samples.map((s) => ({ p: s.t.p, demand: s.t.demand, t: s.t })), eps);
console.log(`jev (mass, eps ${eps}): picks ${JSON.stringify(jevSelf.picks)}, planned with Opus requested ${JSON.stringify(jevSelf.plan.picks)}`);
console.log(`raw laya      : ${fmt(score(samples.map((s) => ({ ...rawOf(s.x), t: s.t })), eps))}`);
// Reference points: a head that learned nothing but the base rate would land near "always sonnet".
const constant = (tier: string): { p: Record<string, number>; demand: number } => ({ p: { haiku: 0, sonnet: 0, opus: 0, [tier]: 1 }, demand: tier === "haiku" ? 0 : 2 });
for (const tier of ["sonnet", "opus"]) console.log(`always ${tier.padEnd(7)}: ${fmt(score(samples.map((s) => ({ ...constant(tier), t: s.t })), eps))}`);

let best: { lambda: number; s: Scores } | null = null;
for (const lambda of [0.001, 0.01, 0.03, 0.1, 0.3, 1]) {
  const oof = crossValidate(samples, lambda);
  const s = score(samples.map((smp, i) => ({ ...oof[i]!, t: smp.t })), eps);
  console.log(`cv lambda ${String(lambda).padEnd(5)}: ${fmt(s)}`);
  if (best === null || s.xent < best.s.xent) best = { lambda, s };
}
console.log(`chosen lambda ${best!.lambda} (lowest cross-validated cross-entropy)`);

if (write) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const cal: LayaCalibration = calibrationOf(`cal-${day}`, FEATURE_VERSION, samples, best!.lambda, {
    samples: samples.length,
    groups: new Set(samples.map((s) => s.group)).size,
    lambda: best!.lambda,
    eps,
    cv_agree: Math.round((1000 * best!.s.agree) / best!.s.n) / 1000,
    cv_under: Math.round((1000 * best!.s.under) / best!.s.n) / 1000,
    cv_over: Math.round((1000 * best!.s.over) / best!.s.n) / 1000,
    cv_plan_agree: Math.round((1000 * best!.s.plan.agree) / best!.s.n) / 1000,
    cv_plan_under: Math.round((1000 * best!.s.plan.under) / best!.s.n) / 1000,
    sources: JSON.stringify(bySource),
  });
  const all = { ...LAYA_CALIBRATIONS, [model]: cal };
  const file = new URL("../../src/backend/laya-calibration.generated.ts", import.meta.url);
  fs.writeFileSync(
    file,
    `// Generated by scripts/calibrate/fit.ts from recorded Jev/Laya pairs; do not edit by hand. Parameters only: no text.\n` +
      `import type { LayaModel } from "../config.js";\nimport type { LayaCalibration } from "./laya-calibration.js";\n\n` +
      `export const LAYA_CALIBRATIONS: Partial<Record<LayaModel, LayaCalibration>> = ${JSON.stringify(all, null, 2)};\n`,
  );
  console.log(`wrote ${model} (${cal.version}) to src/backend/laya-calibration.generated.ts`);
}
