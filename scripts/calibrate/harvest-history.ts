// Calibration data from the prompts you typed in past Claude Code sessions (~/.claude/projects/*/*.jsonl). Each is
// built into the product's decision state (same budget, same redaction, the previous assistant reply and the model that
// answered) and harvested (harvest.ts). The prompts stay in memory; only numbers are written. They DO go to TypeSafe
// Jev, the teacher, so run this only with the owner's consent.
//
//   node --import tsx scripts/calibrate/harvest-history.ts [--out ~/.reflex/calibration/history.jsonl] [--exclude <substring>]...
// Transcripts whose project directory contains an --exclude substring are skipped (e.g. calibration sessions already
// recorded through REFLEX_COMPARE).
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { harvest } from "./harvest.js";
import { historyItems } from "./history.js";

const args = process.argv.slice(2);
const values = (name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]!] : []));
const out = values("--out")[0] ?? path.join(os.homedir(), ".reflex", "calibration", "history.jsonl");
const exclude = values("--exclude");
const loaded = loadConfig({});
if (!loaded.ok) throw new Error(loaded.errors.join("; "));
const cfg = loaded.config;

const { items, transcripts: file } = historyItems(cfg, exclude);
console.log(`${items.length} typed prompts from ${file} transcripts`);
await harvest(cfg, "history", items, out);
