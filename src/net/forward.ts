import http from "node:http";
import https from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sanitizeHeaders } from "./http-util.js";

export interface ForwardRequest {
  readonly method: string;
  /** Path and query exactly as received (origin-form), e.g. `/v1/messages?beta=true`. */
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface ForwardOptions {
  readonly signal?: AbortSignal;
  /** Give up if the TCP/TLS connection is not established in this time. Streams themselves are never time-limited. */
  readonly connectTimeoutMs?: number;
}

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128 });

/** `target` may carry a path prefix (a corporate gateway such as https://gw.example.com/anthropic); it is kept. */
export function targetPath(target: URL, url: string): string {
  const base = target.pathname.replace(/\/+$/, "");
  const origin = url.startsWith("/") ? url : (() => { const u = new URL(url, "http://placeholder"); return u.pathname + u.search; })();
  return base + origin;
}

/**
 * Sends the request to `target` and resolves as soon as the response HEADERS arrive; the body is left as a stream.
 * Rejects if no response headers were received (connect failure, reset, abort, connect timeout).
 * Request bytes are sent exactly as given; nothing is parsed or re-serialised here.
 */
export function forward(target: URL, req: ForwardRequest, opts: ForwardOptions = {}): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const secure = target.protocol === "https:";
    const headers = sanitizeHeaders(req.headers, "request");
    headers["host"] = target.host;
    if (req.body.length > 0 || !["GET", "HEAD", "DELETE", "OPTIONS"].includes(req.method)) headers["content-length"] = String(req.body.length);

    const options: http.RequestOptions = {
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ""),
      method: req.method,
      path: targetPath(target, req.url),
      headers,
      agent: secure ? httpsAgent : httpAgent,
    };
    if (target.port !== "") options.port = Number(target.port);
    if (opts.signal) options.signal = opts.signal;

    let connectTimer: NodeJS.Timeout | undefined;
    const out = (secure ? https : http).request(options, (res) => {
      clearTimeout(connectTimer);
      resolve(res);
    });
    if (opts.connectTimeoutMs !== undefined) {
      const ms = opts.connectTimeoutMs;
      out.once("socket", (socket) => {
        if (!socket.connecting) return;
        connectTimer = setTimeout(() => out.destroy(Object.assign(new Error(`connect timeout after ${ms} ms`), { code: "ECONNTIMEOUT" })), ms);
        socket.once("connect", () => clearTimeout(connectTimer));
      });
    }
    out.on("error", (e) => {
      clearTimeout(connectTimer);
      reject(e);
    });
    out.end(req.body);
  });
}

/** Changes a response's bytes on their way to the client: `push` per chunk, `end` once for anything held back. */
export interface ChunkEdit {
  push(chunk: Buffer): Buffer;
  end(): Buffer;
}

/**
 * Streams an upstream response to the client, headers first. Rejects if the stream breaks; the caller then destroys
 * `res`. `tap` sees every upstream chunk as it arrived; a throwing tap is ignored. `edit` (a deliberate rewrite) is the
 * only thing that may change the bytes the client gets.
 */
export async function relay(upstream: http.IncomingMessage, res: http.ServerResponse, tap?: (chunk: Buffer) => void, edit?: ChunkEdit): Promise<void> {
  res.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, sanitizeHeaders(upstream.headers, "response"));
  if (!tap && !edit) {
    await pipeline(upstream, res);
    return;
  }
  const tee = new Transform({
    transform(chunk: Buffer, _enc, done) {
      const out = edit ? edit.push(chunk) : chunk;
      if (out.length > 0) this.push(out);
      done();
      try {
        tap?.(chunk);
      } catch {
        // observation must never affect the response
      }
    },
    flush(done) {
      const rest = edit?.end();
      done(null, rest !== undefined && rest.length > 0 ? rest : undefined);
    },
  });
  await pipeline(upstream, tee, res);
}
