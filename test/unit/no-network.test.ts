import assert from "node:assert/strict";
import { fork } from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// These assert the offline guard itself (test/support/no-network.ts, preloaded by scripts/run-tests.mjs).
describe("offline guard", () => {
  it("refuses a TCP connection to a non-loopback host", () => {
    assert.throws(() => net.connect(80, "example.com"), /no-network guard/);
    assert.throws(() => net.connect({ host: "93.184.216.34", port: 443 }), /no-network guard/);
  });
  it("refuses DNS lookups of non-loopback names", () => {
    assert.throws(() => dns.lookup("example.com", () => undefined), /no-network guard/);
  });
  it("refuses fetch() to an external URL", async () => {
    await assert.rejects(fetch("http://example.com/"), (e: Error) => /no-network guard|fetch failed/.test(e.message + String((e as { cause?: unknown }).cause)));
  });
  it("allows loopback, including a real round trip", async () => {
    const server = http.createServer((_, res) => void res.end("hi"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, agent: false }, (res) => {
        let s = "";
        res.on("data", (c: Buffer) => (s += c.toString()));
        res.on("end", () => resolve(s));
      }).on("error", reject);
    });
    assert.equal(body, "hi");
    server.close();
  });
  it("is inherited by forked child processes (the worker runs under it too)", async () => {
    const child = fork(fileURLToPath(new URL("../support/probe-guard.ts", import.meta.url)), [], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    await new Promise((r) => child.once("exit", r));
    assert.match(out, /^GUARDED no-network guard/);
  });
});
