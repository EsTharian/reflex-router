// The prompts you typed in past Claude Code sessions (~/.claude/projects/*/*.jsonl), each built into the product's
// decision state (same budget, same redaction, the previous assistant reply and the model that answered). Shared by
// harvest-history.ts and eval-checkpoint.ts; the text stays in the caller's memory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../../src/config.js";
import { buildState } from "../../src/privacy/state.js";
import type { HarvestItem } from "./harvest.js";

type Row = { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown; model?: string } };
type Block = { type?: string; text?: string };
/** A message's text, or null for tool results and empty content. */
const textOf = (c: unknown): string | null => {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return null;
  const blocks = c as Block[];
  if (blocks.some((b) => b.type === "tool_result")) return null;
  const t = blocks.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n");
  return t === "" ? null : t;
};
/** Text the harness injected (command wrappers, caveats, interruptions), not something a person typed. */
const injected = (t: string): boolean => /^\s*</.test(t) || t.startsWith("Caveat:") || t.startsWith("[Request interrupted");

/** Transcripts whose project directory contains an `exclude` substring are skipped. */
export function historyItems(cfg: Config, exclude: readonly string[]): { items: HarvestItem[]; transcripts: number } {
  const items: HarvestItem[] = [];
  const seen = new Set<string>();
  const projects = path.join(os.homedir(), ".claude", "projects");
  let file = 0;
  for (const dir of fs.readdirSync(projects)) {
    if (exclude.some((x) => dir.includes(x))) continue;
    for (const name of fs.readdirSync(path.join(projects, dir)).filter((n) => n.endsWith(".jsonl"))) {
      const group = `h${file++}`; // one transcript's prompts are correlated
      const rows = fs.readFileSync(path.join(projects, dir, name), "utf8").split("\n").flatMap((l): Row[] => {
        try {
          return [JSON.parse(l) as Row];
        } catch {
          return [];
        }
      });
      let previous: string | null = null;
      rows.forEach((r, i) => {
        if (r.isSidechain) return;
        const text = textOf(r.message?.content);
        if (r.type === "assistant") {
          if (text) previous = text;
          return;
        }
        if (r.type !== "user" || r.isMeta || text === null || injected(text) || text.trim().length < 4 || seen.has(text)) return;
        seen.add(text);
        const model = rows.slice(i + 1).find((x) => x.type === "assistant")?.message?.model ?? cfg.models.opus;
        items.push({ state: buildState({ kind: "main", task: text, previousAssistantText: previous, requestedModel: model }, cfg).state, group, kind: "main" });
      });
    }
  }
  return { items, transcripts: file };
}
