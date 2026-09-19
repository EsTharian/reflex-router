import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "../config.js";
import type { EffectiveMode } from "../effective-mode.js";
import { forward, relay } from "../net/forward.js";
import { BodyTooLargeError, readBody, sendAnthropicError } from "../net/http-util.js";
import type { Log } from "../util/log.js";
import { redact } from "../privacy/redact.js";
import { errorSummary } from "../wire/anthropic.js";
import { JevBackend } from "../backend/jev.js";
import { LocalBackend } from "../backend/local.js";
import type { DecisionBackend } from "../backend/types.js";
import { DecisionLog, hashId, type DelegateHintRecord } from "../log/decision-log.js";
import { HINT_VERSION } from "../delegate/hint.js";
import { hintReply } from "../delegate/reply.js";
import { Breaker } from "./breaker.js";
import { Router, type Observation } from "./router.js";
import { HOOK_PATH } from "../outcome/hooks-config.js";
import { parseHookEvent, type HookEvent } from "../outcome/hooks.js";
import { OutcomeTracker, type DecisionInfo } from "../outcome/tracker.js";
import { RecentPrompts } from "./recent-prompts.js";

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
/** How much of a rejected rewrite's error body is read (and how long we wait for it) before retrying. */
const REJECTION_BODY_MAX = 16 * 1024;
const REJECTION_BODY_TIMEOUT_MS = 2000;

/** Reads up to `max` bytes of a response, then discards the rest; resolves null on error or timeout. */
function readBounded(res: http.IncomingMessage, max: number, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (v: Buffer | null): void => {
      clearTimeout(timer);
      res.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    res.on("data", (c: Buffer) => {
      if (size < max) chunks.push(c.subarray(0, max - size));
      size += c.length;
    });
    res.on("end", () => done(Buffer.concat(chunks)));
    res.on("error", () => done(null));
  });
}

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
  const tracker = Router.active(opts.effectiveMode)
    ? new OutcomeTracker({ emit: (r) => void decisionLog.appendRecord(r) })
    : null;
  const prompts = new RecentPrompts();
  // Keep the backend's keep-alive connection open while nothing is being decided: the first decision after an idle gap
  // otherwise pays a fresh TCP+TLS handshake (observations.md: p50 823 ms new vs 382 ms reused). Best effort and
  // fire-and-forget, exactly like the start-up warm; `connection` on each decision record measures whether it worked.
  let warmTimer: NodeJS.Timeout | null = null;
  if (Router.active(opts.effectiveMode)) {
    void backend?.warm?.();
    if (opts.config.warmIntervalMs > 0 && backend?.warm !== undefined) {
      warmTimer = setInterval(() => void backend.warm?.(), opts.config.warmIntervalMs);
      warmTimer.unref(); // never holds the worker open
    }
  }
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
        ...(tracker ? { onDecision: (d: DecisionInfo) => tracker.onDecision(d) } : {}),
        typedPrompts: (sessionId) => prompts.get(sessionId),
        typedPromptCount: (sessionId) => prompts.typedCount(sessionId),
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

    if (url === HOOK_PATH) {
      // Answer first: a hook must never wait on outcome capture. The only body ever sent is the delegation hint
      // (REFLEX_DELEGATE=1, user-typed prompts); anything else, or any failure, is a 204 ("no hook output").
      let event: HookEvent | null = null;
      let reply: Buffer | null = null;
      try {
        event = tracker ? parseHookEvent(body) : null;
        reply = opts.config.delegate ? hintReply(event) : null;
      } catch {
        reply = null;
      }
      if (reply) res.writeHead(200, { "content-type": "application/json", "content-length": reply.length }).end(reply);
      else res.writeHead(204).end();
      if (reply && event) {
        const rec: DelegateHintRecord = { v: 1, record: "delegate_hint", id: crypto.randomUUID(), at: new Date().toISOString(), session: hashId(event.base.sessionId), version: HINT_VERSION };
        void decisionLog.appendRecord(rec);
      }
      if (event?.type === "UserPromptSubmit") prompts.add(event.base.sessionId, event.prompt);
      if (event) tracker?.ingest(event);
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
      let up = await forward(upstream, { method, url, headers: prepared.headers ?? req.headers, body: prepared.body }, { signal: ac.signal });
      if (prepared.rewritten && isRejection(up.statusCode ?? 0)) {
        // The target model refused the rewritten request: send the client's original bytes instead.
        const rejected = up.statusCode ?? 0;
        const errorBody = await readBounded(up, REJECTION_BODY_MAX, REJECTION_BODY_TIMEOUT_MS);
        const ce = up.headers["content-encoding"];
        const summary = errorBody ? errorSummary(errorBody, typeof ce === "string" ? ce : undefined) : null;
        opts.log("warn", `rewritten request rejected with ${rejected}; retrying with the original request`);
        obs?.fallback(rejected, summary === null ? null : redact(summary));
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
        if (warmTimer) clearInterval(warmTimer);
        tracker?.flush();
        server.close(() => void decisionLog.flush().then(() => {
          backend?.close?.();
          resolve();
        }));
        server.closeAllConnections();
      }),
  };
}
