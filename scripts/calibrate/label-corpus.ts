// Fine-tuning data for Laya from a SYNTHETIC task corpus (same input as harvest-corpus.ts): each task is built into the
// product's decision state and put to Jev with the product's questions; Jev's answer distributions are the soft gold.
// Unlike the harvest scripts this WRITES THE STATE TEXT, because training needs it: run it only on corpora that may be
// kept and uploaded (synthetic), never on a user's prompts. Output lines are {group, kind, state, questions, gold,
// jev_version}; `gold[id].probabilities` is what Laya's fine-tuning notebook reads as the target.
//
//   node --import tsx scripts/calibrate/label-corpus.ts <corpus.jsonl> <out.jsonl>
// Needs TYPESAFE_API_KEY (environment or ~/.reflex/env).
import fs from "node:fs";
import path from "node:path";
import { JevBackend } from "../../src/backend/jev.js";
import { loadConfig } from "../../src/config.js";
import { mergeEnvFile } from "../../src/env-file.js";
import { buildQuestions } from "../../src/policy.js";
import { buildState } from "../../src/privacy/state.js";
import { groupOf } from "./lib.js";

const [input, out] = process.argv.slice(2);
if (!input || !out) throw new Error("usage: label-corpus.ts <corpus.jsonl> <out.jsonl>");
const loaded = loadConfig({});
if (!loaded.ok) throw new Error(loaded.errors.join("; "));
const cfg = loaded.config;
const key = mergeEnvFile(process.env).env["TYPESAFE_API_KEY"]?.trim();
if (!key) throw new Error("TYPESAFE_API_KEY is needed (the teacher is Jev)");

const items = fs
  .readFileSync(input, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as { task: string; kind: "main" | "subagent"; previous: string | null });
const questions = buildQuestions(cfg);
const jev = new JevBackend({ baseUrl: cfg.jevBaseUrl, apiKey: key, deadlineMs: 15_000 });
const signal = { signal: new AbortController().signal };

fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
const fd = fs.openSync(out, "w", 0o600);
let ok = 0;
for (const it of items) {
  const state = buildState({ kind: it.kind, task: it.task, previousAssistantText: it.previous, requestedModel: cfg.models.opus }, cfg).state;
  try {
    const d = await jev.decide(state, questions, signal);
    fs.writeSync(fd, JSON.stringify({ group: groupOf(it.task), kind: it.kind, state, questions, gold: d.answers, jev_version: d.backendModel }) + "\n");
    ok++;
  } catch (e) {
    console.error(`jev: ${e instanceof Error ? e.message : "error"}`);
  }
}
fs.closeSync(fd);
jev.close();
console.log(`labelled ${ok}/${items.length} to ${out}`);
