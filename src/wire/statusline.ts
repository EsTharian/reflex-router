// What Claude Code pipes to a `statusLine` command on stdin (observed on 2.1.280, docs/wire-format.md §7.2): one JSON
// object with, among others, `session_id` (the same id as the requests' session header) and `model.display_name`.
// Only these two are read; anything unexpected yields nulls, never an error.

export interface StatusInput {
  readonly sessionId: string | null;
  readonly displayName: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function parseStatusInput(text: string): StatusInput {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return { sessionId: null, displayName: null };
  }
  if (!isObj(o)) return { sessionId: null, displayName: null };
  return { sessionId: str(o["session_id"]), displayName: isObj(o["model"]) ? str(o["model"]["display_name"]) : null };
}
