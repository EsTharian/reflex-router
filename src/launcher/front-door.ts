// The front door owns the loopback port for the whole life of the session, so there is never a moment where the
// port is unbound. It is deliberately dumb: buffer the request, try the worker, and if the worker is unavailable
// send the very same bytes straight to the upstream. All routing logic lives in the worker.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { forward, relay } from "../net/forward.js";
import { BodyTooLargeError, readBody, sendAnthropicError } from "../net/http-util.js";
import { noopLog, type Log } from "../util/log.js";
import { STATUS_PATH } from "../statusline.js";

export interface FrontDoorOptions {
  readonly upstream: URL;
  /** Where the worker listens right now, or null when it is down. */
  readonly workerOrigin: () => URL | null;
  /** Called when a request could not be handed to the worker before any response bytes flowed. */
  readonly onWorkerUnreachable?: (err: Error) => void;
  /** Extra fields for GET /__reflex/health. */
  readonly status?: () => Record<string, unknown>;
  readonly maxBodyBytes?: number;
  readonly workerConnectTimeoutMs?: number;
  readonly log?: Log;
}

export interface DoorCounters {
  viaWorker: number;
  direct: number;
  hooksHandled: number;
  hooksDropped: number;
}

export interface FrontDoor {
  readonly port: number;
  readonly counters: Readonly<DoorCounters>;
  close(): Promise<void>;
}

export const DEFAULT_MAX_BODY_BYTES = 128 * 1024 * 1024;
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

export async function startFrontDoor(opts: FrontDoorOptions): Promise<FrontDoor> {
  const log = opts.log ?? noopLog;
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const counters: DoorCounters = { viaWorker: 0, direct: 0, hooksHandled: 0, hooksDropped: 0 };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (url === "/__reflex/health" && method === "GET") {
      const body = JSON.stringify({ ok: true, worker: opts.workerOrigin() !== null ? "up" : "down", counters, ...opts.status?.() });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    if (url.startsWith(STATUS_PATH + "?") && method === "GET") {
      // `reflex statusline`: the worker's per-session view, or "down" (the session then runs straight to the upstream).
      const worker = opts.workerOrigin();
      if (worker) {
        try {
          await relay(await forward(worker, { method, url, headers: {}, body: Buffer.alloc(0) }, { connectTimeoutMs: opts.workerConnectTimeoutMs ?? 1000 }), res);
          return;
        } catch {
          // fall through
        }
      }
      if (res.headersSent) res.destroy();
      else res.writeHead(200, { "content-type": "application/json" }).end('{"worker":"down"}');
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req, maxBody);
    } catch (e) {
      if (e instanceof BodyTooLargeError) sendAnthropicError(res, 413, "request_too_large", "request body too large");
      else res.destroy();
      return;
    }

    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort(); // client went away: stop the upstream request too
    });
    const fr = { method, url, headers: req.headers, body };

    if (url === "/__reflex/hook") {
      // Claude Code hook events. Best effort: never let a hook failure surface in the user's session.
      const worker = opts.workerOrigin();
      if (worker) {
        try {
          const up = await forward(worker, fr, { signal: ac.signal, connectTimeoutMs: opts.workerConnectTimeoutMs ?? 1000 });
          counters.hooksHandled++;
          await relay(up, res);
          return;
        } catch {
          // fall through to the silent 204
        }
      }
      counters.hooksDropped++;
      if (!res.headersSent) res.writeHead(204).end();
      else res.destroy();
      return;
    }
    if (url.startsWith("/__reflex/")) {
      sendAnthropicError(res, 404, "not_found_error", "unknown reflex endpoint");
      return;
    }

    const worker = opts.workerOrigin();
    if (worker) {
      try {
        const up = await forward(worker, fr, { signal: ac.signal, connectTimeoutMs: opts.workerConnectTimeoutMs ?? 1000 });
        counters.viaWorker++;
        await relay(up, res);
        return;
      } catch (e) {
        if (ac.signal.aborted) return;
        if (res.headersSent) {
          res.destroy(); // the worker died mid-stream; the client's own retry logic takes over
          return;
        }
        log("warn", `worker unreachable, forwarding directly: ${asError(e).message}`);
        opts.onWorkerUnreachable?.(asError(e));
      }
    }

    try {
      const up = await forward(opts.upstream, fr, { signal: ac.signal });
      counters.direct++;
      await relay(up, res);
    } catch (e) {
      if (ac.signal.aborted) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendAnthropicError(res, 502, "api_error", `reflex: upstream unreachable (${asError(e).message})`);
    }
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log("error", `front door handler failed: ${asError(e).message}`);
      if (!res.headersSent) sendAnthropicError(res, 502, "api_error", "reflex: internal error");
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 60_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    counters,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
