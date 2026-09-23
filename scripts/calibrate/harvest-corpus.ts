// Calibration data from a JSONL corpus of tasks ({"task", "kind": "main"|"subagent", "previous": string|null} per
// line): each is built into the product's decision state (same budget, same redaction) and harvested (harvest.ts:
// Jev and every Laya checkpoint, numbers only written).
//
//   node --import tsx scripts/calibrate/harvest-corpus.ts <corpus.jsonl> <out.jsonl>
// Needs TYPESAFE_API_KEY (environment or ~/.reflex/env) and laya-serve on PATH.
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { buildState } from "../../src/privacy/state.js";
import { harvest } from "./harvest.js";
import { groupOf } from "./lib.js";

const [input, out] = process.argv.slice(2);
if (!input || !out) throw new Error("usage: harvest-corpus.ts <corpus.jsonl> <out.jsonl>");
const loaded = loadConfig({});
if (!loaded.ok) throw new Error(loaded.errors.join("; "));
const cfg = loaded.config;

const items = fs
  .readFileSync(input, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as { task: string; kind: "main" | "subagent"; previous: string | null });
await harvest(
  cfg,
  path.basename(input, ".jsonl"),
  items.map((it) => ({ state: buildState({ kind: it.kind, task: it.task, previousAssistantText: it.previous, requestedModel: cfg.models.opus }, cfg).state, group: groupOf(it.task), kind: it.kind })),
  out,
);
