import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "../config.js";
import type { EffectiveMode } from "../effective-mode.js";
import { forward, relay } from "../net/forward.js";
import { BodyTooLargeError, readBody, sendAnthropicError } from "../net/http-util.js";
import type { Log } from "../util/log.js";

export interface WorkerOptions {
  readonly config: Config;
  readonly effectiveMode: EffectiveMode;
  readonly degradedReason: string | null;
  readonly claudeVersion: string | null;
  readonly log: Log;
}

export interface WorkerServer {
  readonly port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 128 * 1024 * 1024;
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * The worker. For now every request is forwarded to the upstream unchanged; this is the seam where request
 * classification and routing decisions plug in. Anything unexpected must end in "forward the original bytes".
 */
export async function startWorkerServer(opts: WorkerOptions): Promise<WorkerServer> {
  const upstream = new URL(opts.config.upstreamUrl);
  const startedAt = Date.now();

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (url === "/__reflex/health" && method === "GET") {
      const body = JSON.stringify({ ok: true, pid: process.pid, uptimeS: Math.round((Date.now() - startedAt) / 1000), mode: opts.effectiveMode, degradedReason: opts.degradedReason, claudeVersion: opts.claudeVersion });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (e) {
      if (e instanceof BodyTooLargeError) sendAnthropicError(res, 413, "request_too_large", "request body too large");
      else res.destroy();
      return;
    }

    if (url === "/__reflex/hook") {
      res.writeHead(204).end(); // hook events are accepted and ignored for now
      return;
    }

    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    try {
      const up = await forward(upstream, { method, url, headers: req.headers, body }, { signal: ac.signal });
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
      opts.log("error", `handler failed: ${asError(e).stack ?? asError(e).message}`);
      if (!res.headersSent) sendAnthropicError(res, 502, "api_error", "reflex: internal error");
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
