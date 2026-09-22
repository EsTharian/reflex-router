// Anthropic Messages API response shapes: token usage from an SSE stream or a JSON body, and error summaries. Fed already-decoded text in
// arbitrary chunks; never throws. Observed on 2.1.277 (docs/wire-format.md §6): `message_start.message.usage` holds
// input/cache counts, `message_delta.usage` the final output count (and sometimes updated input counts).

import zlib from "node:zlib";

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

/** Longest error summary kept; enough for the API's validation messages. */
export const ERROR_SUMMARY_MAX = 500;

/**
 * True when a rejection summary (errorSummary) says the request is larger than the model's context window, e.g.
 * "invalid_request_error: prompt is too long: 244258 tokens > 200000 maximum" (2.1.278
 * experiment.route-haiku-to-fable-and-ceiling). That is about this request's size, not about the target model
 * rejecting the rewrite.
 */
export const isPromptTooLong = (summary: string | null): boolean => summary !== null && /prompt is too long/i.test(summary);

/**
 * `<error.type>: <error.message>` from an Anthropic error body (`{type:"error", error:{type, message}}`), decoded
 * per content-encoding; the first characters of the raw text when it is not that shape; null when unreadable.
 * The caller redacts it before storing.
 */
export function errorSummary(body: Buffer, contentEncoding: string | undefined): string | null {
  let bytes = body;
  try {
    const enc = (contentEncoding ?? "").trim().toLowerCase();
    if (enc === "gzip" || enc === "x-gzip") bytes = zlib.gunzipSync(body);
    else if (enc === "br") bytes = zlib.brotliDecompressSync(body);
    else if (enc === "deflate") bytes = zlib.inflateSync(body);
    else if (enc !== "" && enc !== "identity") return `undecodable body (${enc})`;
  } catch {
    return "undecodable body";
  }
  const text = bytes.toString("utf8");
  if (text.trim() === "") return null;
  try {
    const o: unknown = JSON.parse(text);
    if (isObj(o) && isObj(o["error"])) {
      const e = o["error"];
      const s = [typeof e["type"] === "string" ? e["type"] : null, typeof e["message"] === "string" ? e["message"] : null].filter(Boolean).join(": ");
      if (s !== "") return s.slice(0, ERROR_SUMMARY_MAX);
    }
  } catch {
    // not JSON
  }
  return text.slice(0, ERROR_SUMMARY_MAX);
}
