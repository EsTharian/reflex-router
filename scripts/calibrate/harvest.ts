// Shared by the harvest-*.ts scripts: puts decision states to Jev (the teacher) and to Laya (every checkpoint) and
// writes NUMBERS ONLY - Laya's feature vectors and Jev's tier probabilities and reasoning score. The states' text is
// never written; it is sent to Jev and to the local laya-serve, and lives in this process's memory.
import fs from "node:fs";
import path from "node:path";
import { JevBackend } from "../../src/backend/jev.js";
import { LayaBackend } from "../../src/backend/laya.js";
import { FEATURE_VERSION } from "../../src/backend/laya-calibration.js";
import { LAYA_MODELS, type Config } from "../../src/config.js";
import { mergeEnvFile } from "../../src/env-file.js";
import { realResolveIO, resolveBin } from "../../src/launcher/claude-bin.js";
import { sanitizedEnv } from "../../src/launcher/launch.js";
import { startLaya } from "../../src/launcher/laya.js";
import { buildQuestions } from "../../src/policy.js";
import type { DecisionState } from "../../src/types.js";
import { jevTarget } from "./lib.js";

export interface HarvestItem {
  readonly state: DecisionState;
  /** Items in one group are correlated; cross-validation keeps a group in one fold. Written as is: never text. */
  readonly group: string;
  readonly kind: "main" | "subagent";
}

export async function harvest(cfg: Config, source: string, items: readonly HarvestItem[], out: string): Promise<void> {
  const env = mergeEnvFile(process.env).env;
  const key = env["TYPESAFE_API_KEY"]?.trim();
  if (!key) throw new Error("TYPESAFE_API_KEY is needed (the teacher is Jev)");
  const bin = resolveBin("laya-serve", env["REFLEX_LAYA_BIN"]?.trim() || undefined, realResolveIO(process.env));
  if (!bin) throw new Error("laya-serve is not on PATH");
  const questions = buildQuestions(cfg);
  const signal = { signal: new AbortController().signal };
  const rows: Record<string, unknown>[] = items.map((it) => ({ source, group: it.group, kind: it.kind }));

  const jev = new JevBackend({ baseUrl: cfg.jevBaseUrl, apiKey: key, deadlineMs: 15_000 });
  for (const [i, it] of items.entries()) {
    try {
      const d = await jev.decide(it.state, questions, signal);
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
      for (const [i, it] of items.entries()) {
        try {
          const r = await laya.decideWithFeatures(it.state, questions, signal);
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

  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  fs.writeFileSync(out, rows.map((r) => JSON.stringify({ ...r, feature_version: FEATURE_VERSION })).join("\n") + "\n", { mode: 0o600 });
  console.log(`wrote ${rows.length} rows (numbers only) to ${out}`);
}
