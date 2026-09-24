// Asks Jev a batch of questions for the brainstorm skill, reusing the product's Jev client and ~/.reflex/env reader.
//
//   node --import tsx .claude/skills/brainstorm/jev.ts <requests.json>
//
// <requests.json> is an array of { "id", "state", "questions"? }; a request without `questions` gets panel.json.
// Prints one JSON line per request: { id, model, answers } or { id, error }. Everything sent must be English.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JevBackend } from "../../../src/backend/jev.js";
import { DEFAULT_JEV_BASE_URL } from "../../../src/config.js";
import { mergeEnvFile } from "../../../src/env-file.js";
import type { Answer, DecisionState, QuestionSet } from "../../../src/types.js";

interface Request {
  readonly id: string;
  readonly state: unknown;
  readonly questions?: QuestionSet;
}

const file = process.argv[2];
if (!file) throw new Error("usage: jev.ts <requests.json>");
const panel = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "panel.json"), "utf8")) as QuestionSet;
const requests = JSON.parse(fs.readFileSync(file, "utf8")) as Request[];

// Jev gets English only: a Turkish letter anywhere means a sentence slipped through untranslated.
for (const r of requests) {
  if (/[çğıöşüÇĞİÖŞÜ]/.test(JSON.stringify([r.state, r.questions ?? {}]))) throw new Error(`${r.id}: not English, translate before asking Jev`);
}

const env = mergeEnvFile(process.env).env;
const key = env["TYPESAFE_API_KEY"]?.trim();
if (!key) throw new Error("TYPESAFE_API_KEY is needed (environment or ~/.reflex/env)");
const jev = new JevBackend({ baseUrl: env["REFLEX_JEV_BASE_URL"]?.trim() || DEFAULT_JEV_BASE_URL, apiKey: key, deadlineMs: 30_000 });

const r2 = (n: number): number => Math.round(n * 100) / 100;
const compact = (a: Answer): unknown =>
  a.type === "noul"
    ? r2(a.p)
    : a.type === "score"
      ? { score: r2(a.score), of: Object.keys(a.probabilities).length - 1, conf: r2(a.confidence) }
      : { choice: a.choice, p: Object.fromEntries(Object.entries(a.probabilities).map(([k, p]) => [k, r2(p)])), conf: r2(a.confidence) };

// ponytail: 4 at a time and no retry; a 429/529 shows up as an error line, re-run just those ids.
const lines: string[] = new Array<string>(requests.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(4, requests.length) }, async () => {
    while (next < requests.length) {
      const i = next++;
      const r = requests[i]!;
      try {
        // The client is typed for the router's own state; the wire accepts any JSON state.
        const d = await jev.decide(r.state as DecisionState, r.questions ?? panel, { signal: new AbortController().signal });
        lines[i] = JSON.stringify({ id: r.id, model: d.backendModel, answers: Object.fromEntries(Object.entries(d.answers).map(([q, a]) => [q, compact(a)])) });
      } catch (e) {
        lines[i] = JSON.stringify({ id: r.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }),
);
jev.close();
console.log(lines.join("\n"));
