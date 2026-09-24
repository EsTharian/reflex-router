// The effort messages reflex added to conversations (src/wire/effort.ts), by the hash of the history before each one.
// Kept in <home>/effort.jsonl so a worker restart, or a conversation resumed through reflex later, re-inserts them
// too: leaving one out edits the history the model saw. Hashes and levels only, never text. It is read whatever
// REFLEX_EFFORT says, so turning the setting off does not strand the conversations it already changed.
import fs from "node:fs";
import path from "node:path";
import type { Effort } from "../types.js";
import type { Log } from "../util/log.js";
import { isEffort } from "../wire/effort.js";

export class EffortStore {
  readonly #byAnchor = new Map<string, Effort>();

  // ponytail: read once at start and never pruned. Another reflex session's additions are only seen after a restart
  // (matters only for one conversation open in two sessions at once); prune by age if the file ever grows large.
  constructor(
    readonly file: string,
    private readonly logger: Log,
  ) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return; // none yet
    }
    for (const line of text.split("\n")) {
      try {
        const o = JSON.parse(line) as { anchor?: unknown; effort?: unknown };
        if (typeof o.anchor === "string" && /^[0-9a-f]{64}$/.test(o.anchor) && isEffort(o.effort)) this.#byAnchor.set(o.anchor, o.effort);
      } catch {
        // a torn or foreign line; skip it
      }
    }
  }

  static at(home: string, logger: Log): EffortStore {
    return new EffortStore(path.join(home, "effort.jsonl"), logger);
  }

  get(anchor: string): Effort | undefined {
    return this.#byAnchor.get(anchor);
  }

  /** In memory at once; on disk synchronously, so the next request of the conversation can never miss it. */
  add(anchor: string, effort: Effort): void {
    if (this.#byAnchor.get(anchor) === effort) return;
    this.#byAnchor.set(anchor, effort);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, JSON.stringify({ v: 1, at: new Date().toISOString(), anchor, effort }) + "\n", { mode: 0o600 });
    } catch (e) {
      this.logger("warn", `effort store: could not write ${this.file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
