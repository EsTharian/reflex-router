// A loopback stand-in for TypeSafe's /v1/systemone. Scriptable: answers, latency, HTTP errors, junk, hangs.
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface JevCall {
  readonly headers: http.IncomingHttpHeaders;
  readonly body: { state: unknown; model: unknown; questions: Record<string, { type: string; criteria: unknown }> };
  readonly raw: string;
  /** Client-side port of the TCP connection: equal ports mean a reused connection. */
  readonly remotePort: number | undefined;
}

export type JevBehaviour =
  | { readonly kind: "answer"; readonly tier: string; readonly confidence?: number; readonly reasoning?: number; readonly delayMs?: number }
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "junk" }
  | { readonly kind: "raw"; readonly body: unknown }
  | { readonly kind: "hang" }
  /** Destroys the connection without answering, once; then answers like `then`. */
  | { readonly kind: "reset_once"; readonly then: JevBehaviour };

export interface FakeJev {
  readonly url: string;
  readonly calls: JevCall[];
  /** Requests other than POST /v1/systemone (e.g. connection warm-ups), with their headers. */
  readonly other: { method: string; url: string; headers: http.IncomingHttpHeaders; remotePort: number | undefined }[];
  set(b: JevBehaviour): void;
  /** Closes keep-alive connections that are idle, like a server-side idle timeout would. */
  dropIdle(): void;
  close(): Promise<void>;
}

/** A well-formed answer for whatever questions were asked: `tier` wins the choice, `reasoning` is the score. */
export function answerFor(questions: JevCall["body"]["questions"], tier: string, confidence = 0.9, reasoning = 0.5): unknown {
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      const opts = Object.keys(q.criteria as object);
      const rest = (1 - confidence) / Math.max(1, opts.length - 1);
      answers[id] = { type: "choice", choice: tier, confidence, probabilities: Object.fromEntries(opts.map((o) => [o, o === tier ? confidence : rest])) };
    } else if (q.type === "score") {
      const n = (q.criteria as unknown[]).length;
      const lo = Math.floor(reasoning);
      const frac = reasoning - lo;
      const probabilities = Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), i === lo ? 1 - frac : i === lo + 1 ? frac : 0]));
      answers[id] = { type: "score", score: reasoning, confidence: 0.6, legend: {}, probabilities };
    } else answers[id] = { type: "noul", noul: 0.5 };
  }
  return { model: "jev-test", answers, usage: { input_tokens: 321, output_tokens: 0 } };
}

export async function startFakeJev(initial: JevBehaviour = { kind: "answer", tier: "haiku" }): Promise<FakeJev> {
  let behaviour = initial;
  const calls: JevCall[] = [];
  const other: FakeJev["other"] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/systemone") {
      other.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, remotePort: req.socket.remotePort });
      req.resume();
      res.writeHead(404, { "content-length": 0 }).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw) as JevCall["body"];
      calls.push({ headers: req.headers, body, raw, remotePort: req.socket.remotePort });
      let b = behaviour;
      if (b.kind === "reset_once") {
        behaviour = b.then;
        req.socket.destroy();
        return;
      }
      b = behaviour;
      const send = (status: number, payload: string): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(payload);
      };
      switch (b.kind) {
        case "answer":
          setTimeout(() => send(200, JSON.stringify(answerFor(body.questions, b.tier, b.confidence, b.reasoning))), b.delayMs ?? 0);
          return;
        case "status":
          send(b.status, JSON.stringify({ error: { message: "secret-looking error body apikey_shouldnotleak" } }));
          return;
        case "junk":
          send(200, "<html>not json");
          return;
        case "raw":
          send(200, JSON.stringify(b.body));
          return;
        case "hang":
        case "reset_once":
          return; // never answers; the client's deadline must fire
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    other,
    set: (b) => {
      behaviour = b;
    },
    dropIdle: () => server.closeIdleConnections(),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
