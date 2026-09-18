import http from "node:http";

export interface Resp {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface RequestOptions {
  readonly method?: string;
  readonly headers?: http.OutgoingHttpHeaders;
  readonly body?: Buffer | string;
}

/** Raw HTTP client: no decompression, no redirects, no keep-alive agent. What comes back is what was on the wire. */
export function request(url: string, opts: RequestOptions = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = typeof opts.body === "string" ? Buffer.from(opts.body) : opts.body;
    const headers: http.OutgoingHttpHeaders = { ...opts.headers };
    if (body !== undefined) headers["content-length"] = body.length;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? "GET", headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Opens a request and hands back the live response so tests can look at chunk timing or abort midway. */
export function requestStream(url: string, opts: RequestOptions = {}): Promise<{ res: http.IncomingMessage; req: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = typeof opts.body === "string" ? Buffer.from(opts.body) : opts.body;
    const headers: http.OutgoingHttpHeaders = { ...opts.headers };
    if (body !== undefined) headers["content-length"] = body.length;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? "GET", headers, agent: false }, (res) => resolve({ res, req }));
    req.on("error", reject);
    req.end(body);
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | Promise<T>, opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {}): Promise<NonNullable<T>> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${opts.what ?? "condition"}`);
    await sleep(opts.intervalMs ?? 25);
  }
}
