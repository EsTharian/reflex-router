// `reflex statusline`: the `statusLine` command reflex injects into the claude it launches (unless the user has their
// own). Claude Code shows the model it asked for; this line shows the one reflex actually sent. It asks the session's
// own front door (ANTHROPIC_BASE_URL, loopback only) and prints one line; any failure prints an empty line. The dollar
// figures are estimates at list prices, computed as `reflex report` section 8 does (src/worker/session-status.ts).
import http from "node:http";
import { tierOfModel, tierRank } from "./tiers.js";
import { parseStatusInput } from "./wire/statusline.js";

export const STATUS_PATH = "/__reflex/status";
const TIMEOUT_MS = 300;

interface Pair {
  readonly requested: string | null;
  readonly sent: string;
}
export interface StatusBody {
  readonly worker: "up" | "down";
  readonly main?: Pair | null;
  readonly subagents?: readonly Pair[];
  /** Estimated $ saved (list prices; negative when routing cost more): this session, and all logged sessions. */
  readonly saved?: { readonly session: number; readonly total: number | null };
}

/** `claude-opus-5-5[1m]` -> `Opus 5.5`, `claude-haiku-4-5-20251001` -> `Haiku 4.5`; anything else unchanged. */
export function shortModel(id: string): string {
  const m = /^claude-([a-z]+)((?:-\d{1,2})+)(?:-\d{8})?(?:\[1m\])?$/.exec(id.toLowerCase());
  if (!m) return id;
  const family = m[1] as string;
  return `${family[0]?.toUpperCase()}${family.slice(1)} ${(m[2] as string).slice(1).replaceAll("-", ".")}`;
}

const routed = (p: Pair): boolean => p.requested !== null && p.requested !== p.sent;
const arrow = (p: Pair): string => {
  const a = tierOfModel(p.requested);
  const b = tierOfModel(p.sent);
  return a === null || b === null || a === b ? "⇄" : tierRank(b) < tierRank(a) ? "⇣" : "⇡";
};
/** `$0.42`, `−$0.20`: cents, a real minus sign. */
export const money = (usd: number): string => `${usd < -0.005 ? "−" : ""}$${Math.abs(usd).toFixed(2)}`;
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Pure. The line for one session; null prints nothing (not behind reflex, or nothing to say yet). */
export function formatStatus(s: StatusBody | null): string | null {
  if (s === null) return null;
  if (s.worker === "down") return `${DIM}reflex: passthrough${RESET}`;
  const parts: string[] = [];
  const main = s.main ?? null;
  if (main !== null && routed(main)) parts.push(`${YELLOW}${arrow(main)} ${shortModel(main.sent)}${RESET} ${DIM}(asked ${shortModel(main.requested as string)})${RESET}`);
  else if (main !== null) parts.push(`${DIM}reflex:${RESET} ${shortModel(main.sent)}`);
  else parts.push(`${DIM}reflex${RESET}`); // nothing decided yet: still say whose line this is
  const subs = new Map<string, number>();
  for (const p of s.subagents ?? []) if (routed(p)) subs.set(p.sent, (subs.get(p.sent) ?? 0) + 1);
  if (subs.size > 0) parts.push(`${DIM}subagents${RESET} ${[...subs].map(([m, n]) => `${YELLOW}→ ${shortModel(m)}${n > 1 ? ` ×${n}` : ""}${RESET}`).join(", ")}`);
  const saved = s.saved;
  if (saved !== undefined && (Math.abs(saved.session) >= 0.005 || Math.abs(saved.total ?? 0) >= 0.005)) {
    parts.push(`${DIM}est. saved${RESET} ${money(saved.session)}${saved.total === null ? "" : ` ${DIM}(total ${money(saved.total)})${RESET}`}`);
  }
  return parts.join(` ${DIM}·${RESET} `);
}

/** GET the status from a loopback base URL; null on anything unexpected. */
export function fetchStatus(base: string | undefined, sessionId: string, timeoutMs = TIMEOUT_MS): Promise<StatusBody | null> {
  let url: URL;
  try {
    url = new URL(`${STATUS_PATH}?session=${encodeURIComponent(sessionId)}`, base);
  } catch {
    return Promise.resolve(null);
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return Promise.resolve(null); // loopback only
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => {
        try {
          const o = JSON.parse(text) as StatusBody;
          resolve(res.statusCode === 200 && (o.worker === "up" || o.worker === "down") ? o : null);
        } catch {
          resolve(null);
        }
      });
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

const readStdin = (): Promise<string> =>
  new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => (text += c));
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
  });

export async function statuslineCommand(io: { stdout: (t: string) => void; env: NodeJS.ProcessEnv }): Promise<number> {
  try {
    const input = parseStatusInput(await readStdin());
    const line = input.sessionId === null ? null : formatStatus(await fetchStatus(io.env["ANTHROPIC_BASE_URL"], input.sessionId));
    io.stdout(`${line ?? ""}\n`);
  } catch {
    io.stdout("\n");
  }
  return 0;
}
