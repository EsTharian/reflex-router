import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";

/** RFC 9110 §7.6.1 hop-by-hop fields. `transfer-encoding` is handled by the HTTP stack on each hop. */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

/** Header names the sender listed in `Connection:` are hop-by-hop for that message too. */
export function connectionListed(headers: IncomingHttpHeaders): Set<string> {
  const raw = headers["connection"]; // Node joins repeated Connection headers with ", "
  const tokens = raw === undefined ? [] : raw.split(",");
  return new Set(tokens.map((t) => t.trim().toLowerCase()).filter(Boolean));
}

/** Content codings the proxy can decode to read token usage (node:zlib; zstd needs Node >= 22.15, so it is not offered). */
export const DECODABLE_CODINGS: ReadonlySet<string> = new Set(["gzip", "br", "deflate"]);

/**
 * The proxy's own accept-encoding toward the upstream: the client's offer restricted to codings the proxy can decode,
 * in the client's order and with its q-values. Absent stays absent (the client gets the upstream bytes as they are,
 * so it must never receive a coding it did not offer); an offer with nothing decodable becomes `identity`.
 */
export function narrowAcceptEncoding(value: string): string {
  const kept = value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => DECODABLE_CODINGS.has(t.split(";")[0]?.trim().toLowerCase() ?? ""));
  return kept.length > 0 ? kept.join(", ") : "identity";
}

/**
 * Copies headers for the next hop, minus hop-by-hop fields. For requests `host` and `content-length` are also dropped
 * (the forwarder sets them itself) and `accept-encoding` is narrowed to decodable codings (narrowAcceptEncoding).
 * Everything else, in particular auth headers, content-encoding and anthropic-* headers, passes through untouched.
 */
export function sanitizeHeaders(headers: IncomingHttpHeaders, kind: "request" | "response"): OutgoingHttpHeaders {
  const listed = connectionListed(headers);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const n = name.toLowerCase();
    if (HOP_BY_HOP.has(n) || listed.has(n)) continue;
    if (kind === "request" && (n === "host" || n === "content-length")) continue;
    out[n] = kind === "request" && n === "accept-encoding" ? narrowAcceptEncoding(Array.isArray(value) ? value.join(", ") : value) : value;
  }
  return out;
}

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        chunks.length = 0;
        req.removeAllListeners("data");
        req.resume();
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("client aborted the request")));
  });
}

/** Same JSON envelope the Anthropic API uses, so clients that parse errors keep working. */
export function sendAnthropicError(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ type: "error", error: { type, message } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
