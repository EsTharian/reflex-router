import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

export type UpstreamHandler = (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void;

export interface FakeUpstream {
  readonly url: string;
  readonly port: number;
  readonly seen: Seen[];
  /** Requests whose client disconnected before the response finished. */
  aborted: number;
  setHandler(h: UpstreamHandler): void;
  close(): Promise<void>;
}

export const echoHandler: UpstreamHandler = (req, res, body) => {
  const out = Buffer.from(JSON.stringify({ ok: true, method: req.method, url: req.url, bytes: body.length }));
  res.writeHead(200, { "content-type": "application/json", "content-length": out.length, "x-upstream": "fake" });
  res.end(out);
};

export async function startFakeUpstream(initial: UpstreamHandler = echoHandler): Promise<FakeUpstream> {
  let handler = initial;
  const seen: Seen[] = [];
  const state = { aborted: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.on("close", () => {
        if (!res.writableFinished) state.aborted++;
      });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    seen,
    get aborted() {
      return state.aborted;
    },
    set aborted(v: number) {
      state.aborted = v;
    },
    setHandler: (h) => {
      handler = h;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
