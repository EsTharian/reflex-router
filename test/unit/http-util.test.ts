import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { BodyTooLargeError, HOP_BY_HOP, connectionListed, readBody, sanitizeHeaders, sendAnthropicError } from "../../src/net/http-util.js";
import { request } from "../support/http.js";

describe("sanitizeHeaders", () => {
  it("drops every hop-by-hop header", () => {
    const h: http.IncomingHttpHeaders = Object.fromEntries([...HOP_BY_HOP].map((n) => [n, "x"]));
    assert.deepEqual(sanitizeHeaders(h, "request"), {});
    assert.deepEqual(sanitizeHeaders(h, "response"), {});
  });
  it("drops headers the sender named in Connection", () => {
    const out = sanitizeHeaders({ connection: "close, x-hop", "x-hop": "1", "x-keep": "2" }, "request");
    assert.deepEqual(out, { "x-keep": "2" });
  });
  it("request: drops host and content-length (the forwarder sets both) but keeps everything Claude Code sends", () => {
    const sent: http.IncomingHttpHeaders = {
      host: "127.0.0.1:1", "content-length": "5", authorization: "Bearer t", "x-api-key": "k", "accept-encoding": "gzip, br",
      "anthropic-beta": "a,b", "anthropic-version": "2023-06-01", "x-claude-code-session-id": "s", "x-claude-code-agent-id": "a", "user-agent": "claude-cli/2.1.277",
    };
    const out = sanitizeHeaders(sent, "request");
    assert.equal(out["host"], undefined);
    assert.equal(out["content-length"], undefined);
    for (const k of ["authorization", "x-api-key", "accept-encoding", "anthropic-beta", "anthropic-version", "x-claude-code-session-id", "x-claude-code-agent-id", "user-agent"]) assert.equal(out[k], sent[k], k);
  });
  it("response: keeps content-length and content-encoding so compressed bodies stay valid", () => {
    const out = sanitizeHeaders({ "content-length": "10", "content-encoding": "gzip", "content-type": "text/event-stream", "transfer-encoding": "chunked" }, "response");
    assert.deepEqual(out, { "content-length": "10", "content-encoding": "gzip", "content-type": "text/event-stream" });
  });
  it("skips undefined values and lower-cases names", () => {
    assert.deepEqual(sanitizeHeaders({ "X-Mixed": "1", "x-none": undefined }, "request"), { "x-mixed": "1" });
  });
  it("keeps multi-value headers as arrays", () => {
    assert.deepEqual(sanitizeHeaders({ "set-cookie": ["a=1", "b=2"] }, "response"), { "set-cookie": ["a=1", "b=2"] });
  });
});

describe("connectionListed", () => {
  it("handles absent, single, comma-separated and repeated Connection headers", () => {
    assert.deepEqual([...connectionListed({})], []);
    assert.deepEqual([...connectionListed({ connection: "Keep-Alive, X-Foo " })].sort(), ["keep-alive", "x-foo"]);
  });
});

describe("readBody / sendAnthropicError", () => {
  const withServer = async (limit: number, fn: (url: string) => Promise<void>): Promise<void> => {
    const server = http.createServer((req, res) => {
      readBody(req, limit).then(
        (b) => void res.end(`len=${b.length}`),
        (e: unknown) => (e instanceof BodyTooLargeError ? sendAnthropicError(res, 413, "request_too_large", "too big") : res.destroy()),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  };

  it("reads a body up to the limit, including empty bodies", async () => {
    await withServer(10, async (url) => {
      assert.equal((await request(url, { method: "POST", body: "0123456789" })).body.toString(), "len=10");
      assert.equal((await request(url, { method: "POST" })).body.toString(), "len=0");
    });
  });
  it("rejects a body over the limit with an Anthropic-shaped 413", async () => {
    await withServer(10, async (url) => {
      const r = await request(url, { method: "POST", body: "x".repeat(11) });
      assert.equal(r.status, 413);
      assert.deepEqual(JSON.parse(r.body.toString()), { type: "error", error: { type: "request_too_large", message: "too big" } });
    });
  });
});
