// Calibration data from a JSONL corpus of tasks ({"task", "kind": "main"|"subagent", "previous": string|null} per
// line): each is built into the product's decision state (same budget, same redaction), put to Jev (the teacher) and
// to Laya (every checkpoint), and written as NUMBERS ONLY - Laya's feature vectors and Jev's tier probabilities and
// reasoning score. The corpus text is read, sent, and not written anywhere.
//
//   node --import tsx scripts/calibrate/harvest-corpus.ts <corpus.jsonl> <out.jsonl>
// Needs TYPESAFE_API_KEY (environment or ~/.reflex/env) and laya-serve on PATH.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { JevBackend } from "../../src/backend/jev.js";
import { LayaBackend } from "../../src/backend/laya.js";
import { FEATURE_VERSION } from "../../src/backend/laya-calibration.js";
import { LAYA_MODELS, loadConfig } from "../../src/config.js";
import { mergeEnvFile } from "../../src/env-file.js";
import { realResolveIO, resolveBin } from "../../src/launcher/claude-bin.js";
import { sanitizedEnv } from "../../src/launcher/launch.js";
import { startLaya } from "../../src/launcher/laya.js";
import { buildQuestions } from "../../src/policy.js";
import { buildState } from "../../src/privacy/state.js";
import { jevTarget } from "./lib.js";

const [input, out] = process.argv.slice(2);
if (!input || !out) throw new Error("usage: harvest-corpus.ts <corpus.jsonl> <out.jsonl>");
const env = mergeEnvFile(process.env).env;
const key = env["TYPESAFE_API_KEY"]?.trim();
if (!key) throw new Error("TYPESAFE_API_KEY is needed (the teacher is Jev)");
const bin = resolveBin("laya-serve", env["REFLEX_LAYA_BIN"]?.trim() || undefined, realResolveIO(process.env));
if (!bin) throw new Error("laya-serve is not on PATH");
const loaded = loadConfig({});
if (!loaded.ok) throw new Error(loaded.errors.join("; "));
const cfg = loaded.config;
const questions = buildQuestions(cfg);

const items = fs
  .readFileSync(input, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as { task: string; kind: "main" | "subagent"; previous: string | null });
const states = items.map((it) => buildState({ kind: it.kind, task: it.task, previousAssistantText: it.previous, requestedModel: cfg.models.opus }, cfg).state);
// Items that open with the same three words are likely variations of one template: cross-validation keeps them in one
// fold. Only a short hash of those words is written.
const groupOf = (task: string): string => "c" + crypto.createHash("sha256").update(task.trim().toLowerCase().split(/\s+/).slice(0, 3).join(" ")).digest("hex").slice(0, 10);
const rows: Record<string, unknown>[] = items.map((it) => ({ source: path.basename(input, ".jsonl"), group: groupOf(it.task), kind: it.kind }));
const signal = { signal: new AbortController().signal };

const jev = new JevBackend({ baseUrl: cfg.jevBaseUrl, apiKey: key, deadlineMs: 15_000 });
for (const [i, st] of states.entries()) {
  try {
    const d = await jev.decide(st, questions, signal);
    rows[i]!["jev"] = jevTarget(d.answers);
    rows[i]!["jev_version"] = d.backendModel;
  } catch (e) {
    rows[i]!["jev_error"] = e instanceof Error ? e.message : "error";
  }
}
jev.close();
console.log(`jev: ${rows.filter((r) => r["jev"]).length}/${rows.length}`);

for (const model of LAYA_MODELS) {
  const server = await startLaya({ bin, env: sanitizedEnv(process.env), model, readyTimeoutMs: 300_000, logFile: null });
  try {
    if (!(await server.ready)) throw new Error(`laya-serve (${model}) did not load`);
    const laya = new LayaBackend(new JevBackend({ id: "laya", baseUrl: server.baseUrl, apiKey: server.apiKey, model, deadlineMs: 60_000 }), undefined);
    const latencies: number[] = [];
    for (const [i, st] of states.entries()) {
      try {
        const r = await laya.decideWithFeatures(st, questions, signal);
        rows[i]![`x_${model}`] = r.features;
        latencies.push(r.decision.latencyMs);
      } catch (e) {
        rows[i]![`x_${model}_error`] = e instanceof Error ? e.message : "error";
      }
    }
    laya.close();
    latencies.sort((a, b) => a - b);
    console.log(`laya ${model}: ${latencies.length}/${rows.length}, latency p50 ${latencies[Math.floor(latencies.length / 2)]} ms, p95 ${latencies[Math.floor(latencies.length * 0.95)]} ms`);
  } finally {
    await server.stop();
  }
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, rows.map((r) => JSON.stringify({ ...r, feature_version: FEATURE_VERSION })).join("\n") + "\n", { mode: 0o600 });
console.log(`wrote ${rows.length} rows (numbers only) to ${out}`);
