import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "../config.js";
import type { EffectiveMode } from "../effective-mode.js";
import { forward, relay } from "../net/forward.js";
import { BodyTooLargeError, readBody, sendAnthropicError } from "../net/http-util.js";
import type { Log } from "../util/log.js";
import { JevBackend } from "../backend/jev.js";
import { LocalBackend } from "../backend/local.js";
import type { DecisionBackend } from "../backend/types.js";
import { DecisionLog } from "../log/decision-log.js";
import { Breaker } from "./breaker.js";
import { Router, type Observation } from "./router.js";

export interface WorkerOptions {
  readonly config: Config;
  readonly effectiveMode: EffectiveMode;
  readonly degradedReason: string | null;
  readonly claudeVersion: string | null;
  readonly log: Log;
  /** Tests inject a backend; otherwise it is built from the config. */
  readonly backend?: DecisionBackend | null;
}

function backendFor(config: Config): DecisionBackend | null {
  if (config.backend === "local") return new LocalBackend();
  if (config.typesafeApiKey === undefined) return null;
  return new JevBackend({ baseUrl: config.jevBaseUrl, apiKey: config.typesafeApiKey, deadlineMs: config.jevDeadlineMs });
}

export interface WorkerServer {
  readonly port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 128 * 1024 * 1024;
/** A 4xx that means "this request is not acceptable" (not auth, not rate limiting): the trigger for retry-with-original. */
export const isRejection = (status: number): boolean => status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * The worker. Each POST /v1/messages is classified by the router (shadow: decided off the critical path, forwarded
 * unchanged; route: possibly rewritten). A rewritten request that the upstream rejects is re-sent once with the
 * original bytes. Everything is recorded in decisions.jsonl. Anything unexpected ends in "forward the original bytes".
 */
export async function startWorkerServer(opts: WorkerOptions): Promise<WorkerServer> {
  const upstream = new URL(opts.config.upstreamUrl);
  const startedAt = Date.now();
  const decisionLog = new DecisionLog(opts.config.home, opts.config.logPrompts, { onError: (e) => opts.log("warn", `decision log: ${e.message}`) });
  const backend = opts.backend !== undefined ? opts.backend : backendFor(opts.config);
  const router = Router.active(opts.effectiveMode)
    ? new Router({
        config: opts.config,
        effectiveMode: opts.effectiveMode,
        degradedReason: opts.degradedReason,
        claudeVersion: opts.claudeVersion,
        backend,
        breaker: new Breaker(),
        log: decisionLog,
        logger: opts.log,
      })
    : null;

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
    let obs: Observation | null = null;
    try {
      const prepared = router ? await router.prepare(method, url, req.headers, body) : { body, rewritten: false, obs: null };
      obs = prepared.obs;
      let up = await forward(upstream, { method, url, headers: req.headers, body: prepared.body }, { signal: ac.signal });
      if (prepared.rewritten && isRejection(up.statusCode ?? 0)) {
        // The target model refused the rewritten request: send the client's original bytes instead.
        const rejected = up.statusCode ?? 0;
        up.resume();
        up.destroy();
        opts.log("warn", `rewritten request rejected with ${rejected}; retrying with the original request`);
        obs?.fallback(rejected);
        up = await forward(upstream, { method, url, headers: req.headers, body }, { signal: ac.signal });
      }
      obs?.headers(up.statusCode ?? 0, up.headers);
      await relay(up, res, obs?.tap);
      obs?.finish(true);
    } catch (e) {
      obs?.finish(false);
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
        server.close(() => void decisionLog.flush().then(() => {
          backend?.close?.();
          resolve();
        }));
        server.closeAllConnections();
      }),
  };
}
