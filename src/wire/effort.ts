// Effort on the wire (docs/wire-format.md §5.8). Claude Code's own /effort appends an effort-only system message after
// the new user message and sets the top-level effort too. On Opus 5.5 the message is what changes the level (the
// top-level value alone does nothing while the index-1 system message carries the client's effort), and effort is not
// part of the cache key, so any level in either direction keeps the cache. reflex does exactly the same. Claude Code
// never sends back what reflex added, so every later request of the conversation must carry the added messages again,
// at the same place, or the history the model saw is edited: `withEffort` re-inserts them by the hash of the history
// before them. Sonnet takes no per-message effort and loses its whole cache on a top-level change, so there the level
// is only set on a conversation's first request. Pure.
import crypto from "node:crypto";
import { tierOfModel } from "../tiers.js";
import type { Effort } from "../types.js";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const isEffort = (v: unknown): v is Effort => typeof v === "string" && (EFFORTS as readonly string[]).includes(v);

/** Models whose requests take an added effort message: verified, 2.1.281 (experiment.effort-switch / effort-apply). */
const MESSAGE_EFFORT_MODELS: readonly string[] = ["claude-opus-5-5"];
export const takesEffortMessage = (model: string | null): boolean => model !== null && MESSAGE_EFFORT_MODELS.some((m) => model.toLowerCase().includes(m));

/**
 * How reflex may change the level of a request to `model` this turn: by message (Opus 5.5, any request), by the
 * top-level value (Sonnet, only on a conversation's first request: `fresh`), or not at all (Haiku takes no effort;
 * Opus 5 and Fable are unverified).
 */
export function effortVia(model: string | null, fresh: boolean): "message" | "top-level" | null {
  if (takesEffortMessage(model)) return "message";
  if (fresh && tierOfModel(model) === "sonnet") return "top-level";
  return null;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Claude Code's own effort-only message shape. */
const effortMessage = (effort: Effort): Json => ({ role: "system", content: [], output_config: { effort } });
const messageEffort = (m: unknown): unknown => (isObj(m) && m["role"] === "system" && isObj(m["output_config"]) ? m["output_config"]["effort"] : undefined);

/**
 * A message as the API renders it, not as Claude Code happens to serialise it this time: `cache_control` moves
 * between requests, and the same content is sent as a string on one request and as one text block on the next.
 */
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "cache_control").map(([k, x]) => [k, canon(x)])) : v;
const messageKey = (m: Json): string => JSON.stringify(canon(typeof m["content"] === "string" ? { ...m, content: [{ type: "text", text: m["content"] }] } : m));
/** Hash of the history up to and including `m`, chained from the hash of the history before it. */
const chain = (prev: string, m: Json): string => crypto.createHash("sha256").update(prev).update("\n").update(messageKey(m)).digest("hex");

export interface EffortEdit {
  /** The request to send; the input buffer itself when nothing changed. */
  readonly body: Buffer;
  readonly fields: readonly string[];
  /** The message this request added: stored (by the caller) once the upstream accepts the request. */
  readonly added: { readonly anchor: string; readonly effort: Effort } | null;
}

/**
 * Re-inserts every stored effort message (after the message whose history hash `lookup` knows), then appends one at
 * `add` when that differs from the level now in effect (the last effort message, else the top-level value), and sets
 * the top-level value to the level in effect, as Claude Code does. Null for a body it cannot read.
 */
export function withEffort(body: Buffer, lookup: (anchor: string) => Effort | undefined, add: Effort | null): EffortEdit | null {
  let b: Json;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!isObj(parsed) || !Array.isArray(parsed["messages"])) return null;
    b = parsed;
  } catch {
    return null;
  }
  const out: unknown[] = [];
  let h = "";
  let reinserted = 0;
  for (const m of b["messages"] as unknown[]) {
    out.push(m);
    if (!isObj(m)) continue;
    h = chain(h, m);
    const e = lookup(h);
    if (e !== undefined) {
      out.push(effortMessage(e));
      reinserted++;
    }
  }
  const oc = isObj(b["output_config"]) ? b["output_config"] : {};
  const inMessages = [...out].reverse().map(messageEffort).find((e) => e !== undefined);
  const current = inMessages ?? oc["effort"];
  const added = add !== null && add !== current ? { anchor: h, effort: add } : null;
  if (added) out.push(effortMessage(added.effort));
  if (reinserted === 0 && added === null) return { body, fields: [], added: null };

  const fields: string[] = [];
  if (reinserted > 0) fields.push(`messages.effort_reinserted:${reinserted}`);
  if (added) fields.push("messages.effort_added");
  const effective = added?.effort ?? current;
  if (effective !== oc["effort"]) {
    b["output_config"] = { ...oc, effort: effective };
    fields.push("output_config.effort");
  }
  b["messages"] = out;
  return { body: Buffer.from(JSON.stringify(b)), fields, added };
}

/** Sets the top-level effort (Sonnet). The input buffer itself when it already holds `effort`; null when unreadable. */
export function withTopEffort(body: Buffer, effort: Effort): EffortEdit | null {
  try {
    const b: unknown = JSON.parse(body.toString("utf8"));
    if (!isObj(b)) return null;
    const oc = isObj(b["output_config"]) ? b["output_config"] : {};
    if (oc["effort"] === effort) return { body, fields: [], added: null };
    b["output_config"] = { ...oc, effort };
    return { body: Buffer.from(JSON.stringify(b)), fields: ["output_config.effort"], added: null };
  } catch {
    return null;
  }
}
