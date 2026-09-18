// Anthropic Messages API response shapes: token usage from an SSE stream or a JSON body. Fed already-decoded text in
// arbitrary chunks; never throws. Observed on 2.1.277 (docs/wire-format.md §6): `message_start.message.usage` holds
// input/cache counts, `message_delta.usage` the final output count (and sometimes updated input counts).

export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Largest partial event we keep while waiting for its terminator; a bigger one is skipped, not buffered forever. */
const MAX_PENDING_CHARS = 4 * 1024 * 1024;

export class UsageParser {
  #pending = "";
  #skipping = false;
  #input: number | undefined;
  #output: number | undefined;
  #cacheRead: number | undefined;
  #cacheCreate: number | undefined;
  #json = "";
  #jsonTooBig = false;

  constructor(private readonly format: "sse" | "json") {}

  push(text: string): void {
    if (this.format === "json") {
      if (this.#jsonTooBig) return;
      this.#json += text;
      if (this.#json.length > MAX_PENDING_CHARS) {
        this.#jsonTooBig = true;
        this.#json = "";
      }
      return;
    }
    this.#pending += text;
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.#pending);
      if (!m) break;
      const event = this.#pending.slice(0, m.index);
      this.#pending = this.#pending.slice(m.index + m[0].length);
      if (this.#skipping) this.#skipping = false; // the tail of an oversized event
      else this.#event(event);
    }
    if (this.#pending.length > MAX_PENDING_CHARS) {
      this.#pending = "";
      this.#skipping = true;
    }
  }

  /** Usage once the response is complete, or null when none was seen. */
  result(): Usage | null {
    if (this.format === "json" && this.#json !== "") {
      try {
        const o: unknown = JSON.parse(this.#json);
        if (isObj(o)) this.#take(o["usage"]);
      } catch {
        // not JSON: no usage
      }
      this.#json = "";
    } else if (this.format === "sse" && this.#pending.trim() !== "" && !this.#skipping) {
      this.#event(this.#pending);
      this.#pending = "";
    }
    if (this.#input === undefined && this.#output === undefined) return null;
    return { input: this.#input ?? 0, output: this.#output ?? 0, cacheRead: this.#cacheRead ?? 0, cacheCreate: this.#cacheCreate ?? 0 };
  }

  #event(raw: string): void {
    const data = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data === "") return;
    let o: unknown;
    try {
      o = JSON.parse(data);
    } catch {
      return;
    }
    if (!isObj(o)) return;
    if (o["type"] === "message_start" && isObj(o["message"])) this.#take(o["message"]["usage"]);
    else if (o["type"] === "message_delta") this.#take(o["usage"]);
  }

  #take(u: unknown): void {
    if (!isObj(u)) return;
    this.#input = num(u["input_tokens"]) ?? this.#input;
    this.#output = num(u["output_tokens"]) ?? this.#output;
    this.#cacheRead = num(u["cache_read_input_tokens"]) ?? this.#cacheRead;
    this.#cacheCreate = num(u["cache_creation_input_tokens"]) ?? this.#cacheCreate;
  }
}

/** Which parser a response needs, from its content-type; null when it carries no usage we understand. */
export function usageFormat(contentType: string | undefined): "sse" | "json" | null {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("text/event-stream")) return "sse";
  if (ct.startsWith("application/json")) return "json";
  return null;
}
