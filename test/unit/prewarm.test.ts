// The worker's periodic keep-alive ping to the decision backend (REFLEX_WARM_INTERVAL_MS). Real timers, short
// intervals: the project fakes clocks only for pure logic, never for sockets (see test/unit/jev.test.ts).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JevBackend } from "../../src/backend/jev.js";
import type { DecisionBackend } from "../../src/backend/types.js";
import { startWorkerServer } from "../../src/worker/server.js";
import { startFakeJev } from "../support/fake-jev.js";
import { startFakeUpstream } from "../support/fake-upstream.js";
import { testConfig } from "../support/stack.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A backend that only counts warm-ups; decide() is never reached in these tests. */
const countingBackend = (): { backend: DecisionBackend; warms: () => number } => {
  let warms = 0;
  return {
    warms: () => warms,
    backend: {
      decide: () => Promise.reject(new Error("not used")),
      warm: () => {
        warms++;
        return Promise.resolve();
      },
      close: () => undefined,
    } as unknown as DecisionBackend,
  };
};

describe("periodic pre-warm", () => {
  it("pings the backend on the interval, and stops on close", async () => {
    const upstream = await startFakeUpstream();
    const { backend, warms } = countingBackend();
    const worker = await startWorkerServer({
      config: testConfig(upstream.url, { warmIntervalMs: 30 }),
      effectiveMode: "route",
      degradedReason: null,
      claudeVersion: null,
      log: () => undefined,
      backend,
    });
    await sleep(140);
    const during = warms();
    assert.ok(during >= 3, `expected repeated warm-ups, got ${during}`); // 1 at start-up + >=2 on the interval
    await worker.close();
    const atClose = warms();
    await sleep(120);
    assert.equal(warms(), atClose, "the interval is cleared on close");
    await upstream.close();
  });

  it("warmIntervalMs 0 warms once at start-up and never again", async () => {
    const upstream = await startFakeUpstream();
    const { backend, warms } = countingBackend();
    const worker = await startWorkerServer({
      config: testConfig(upstream.url, { warmIntervalMs: 0 }),
      effectiveMode: "route",
      degradedReason: null,
      claudeVersion: null,
      log: () => undefined,
      backend,
    });
    await sleep(120);
    assert.equal(warms(), 1, "only the start-up warm");
    await worker.close();
    await upstream.close();
  });

  it("passthrough mode never warms: no decision is made, so there is no connection to keep", async () => {
    const upstream = await startFakeUpstream();
    const { backend, warms } = countingBackend();
    const worker = await startWorkerServer({
      config: testConfig(upstream.url, { warmIntervalMs: 30 }),
      effectiveMode: "passthrough",
      degradedReason: "no_backend_key",
      claudeVersion: null,
      log: () => undefined,
      backend,
    });
    await sleep(120);
    assert.equal(warms(), 0);
    await worker.close();
    await upstream.close();
  });

  it("the ping holds ONE connection open: every warm-up reuses the same client port", async () => {
    const upstream = await startFakeUpstream();
    const jev = await startFakeJev();
    const backend = new JevBackend({ baseUrl: jev.url, apiKey: "apikey_test", deadlineMs: 500 });
    const worker = await startWorkerServer({
      config: testConfig(upstream.url, { warmIntervalMs: 30 }),
      effectiveMode: "route",
      degradedReason: null,
      claudeVersion: null,
      log: () => undefined,
      backend,
    });
    await sleep(150);
    await worker.close();
    const ports = jev.other.filter((o) => o.method === "HEAD").map((o) => o.remotePort);
    assert.ok(ports.length >= 3, `expected repeated warm-ups, got ${ports.length}`);
    assert.equal(new Set(ports).size, 1, `every ping should reuse one socket, saw ports ${[...new Set(ports)].join(",")}`);
    await jev.close();
    await upstream.close();
  });
});
