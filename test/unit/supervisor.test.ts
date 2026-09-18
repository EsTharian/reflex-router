import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CrashTracker, Supervisor, type SpawnedWorker, type Timings } from "../../src/launcher/supervisor.js";
import { sleep, waitFor } from "../support/http.js";

const FAST: Partial<Timings> = { probeIntervalMs: 15, probeTimeoutMs: 15, probeMissLimit: 2, backoffInitialMs: 10, backoffMaxMs: 40, crashWindowMs: 10_000, crashLimit: 3, passthroughMs: 80, stableResetMs: 10_000 };

interface FakeWorker extends SpawnedWorker {
  readonly signals: NodeJS.Signals[];
  crash(): void;
}
let nextPort = 40_000;
function fakeWorker(): FakeWorker {
  let resolveExit: () => void = () => undefined;
  const exited = new Promise<void>((r) => (resolveExit = r));
  const signals: NodeJS.Signals[] = [];
  return {
    port: nextPort++,
    exited,
    signals,
    kill: (sig = "SIGTERM") => {
      signals.push(sig);
      resolveExit();
    },
    crash: () => resolveExit(),
  };
}

describe("CrashTracker", () => {
  it("counts only events inside the window", () => {
    const t = new CrashTracker(100);
    t.record(0);
    t.record(50);
    assert.equal(t.count(60), 2);
    assert.equal(t.count(120), 1); // the one at t=0 aged out
    assert.equal(t.count(500), 0);
  });
  it("clear() forgets everything", () => {
    const t = new CrashTracker(100);
    t.record(1);
    t.clear();
    assert.equal(t.count(2), 0);
  });
});

describe("Supervisor", () => {
  const make = (spawn: () => Promise<SpawnedWorker>, over: Partial<Timings> = {}, probe: (p: number) => Promise<boolean> = () => Promise.resolve(true), now?: () => number) =>
    new Supervisor({ spawnWorker: spawn, probe, timings: { ...FAST, ...over }, ...(now ? { now } : {}) });

  it("start() brings a worker up and exposes its origin", async () => {
    const w = fakeWorker();
    const s = make(() => Promise.resolve(w));
    await s.start();
    assert.equal(s.snapshot().state, "up");
    assert.equal(s.workerOrigin()?.href, `http://127.0.0.1:${w.port}/`);
    await s.stop();
  });

  it("a failing first spawn does not throw: no origin, and a retry is scheduled", async () => {
    let calls = 0;
    const w = fakeWorker();
    const s = make(() => (++calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(w)));
    await s.start();
    assert.equal(s.workerOrigin(), null);
    assert.equal(s.snapshot().state, "restarting");
    await waitFor(() => s.snapshot().state === "up", { what: "retry to succeed" });
    assert.equal(s.snapshot().restarts, 1);
    await s.stop();
  });

  it("restarts a crashed worker on a fresh port", async () => {
    const first = fakeWorker();
    const workers = [first];
    const s = make(() => Promise.resolve(workers.shift() ?? fakeWorker()));
    await s.start();
    first.crash();
    await waitFor(() => s.workerOrigin() !== null && s.snapshot().port !== first.port, { what: "restart" });
    assert.equal(s.snapshot().restarts, 1);
    assert.notEqual(s.snapshot().port, first.port);
    await s.stop();
  });

  it("while the worker is down there is no origin (the door forwards directly)", async () => {
    const w = fakeWorker();
    const s = make(() => Promise.resolve(w), { backoffInitialMs: 5000, backoffMaxMs: 5000 });
    await s.start();
    w.crash();
    await waitFor(() => s.snapshot().state === "restarting");
    assert.equal(s.workerOrigin(), null);
    await s.stop();
  });

  it("backs off exponentially between failed attempts, capped at backoffMaxMs", async () => {
    const stamps: number[] = [];
    const s = make(() => {
      stamps.push(Date.now());
      return Promise.reject(new Error("nope"));
    }, { backoffInitialMs: 20, backoffMaxMs: 60, crashLimit: 100 });
    await s.start();
    await waitFor(() => stamps.length >= 5, { timeoutMs: 3000, what: "5 attempts" });
    await s.stop();
    const gaps = stamps.slice(1).map((t, i) => t - (stamps[i] as number));
    assert.ok((gaps[0] as number) >= 15, `gap0 ${gaps[0]}`);
    assert.ok((gaps[1] as number) >= 35, `gap1 ${gaps[1]}`); // ~40
    assert.ok((gaps[3] as number) >= 50 && (gaps[3] as number) < 300, `gap3 ${gaps[3]}`); // capped near 60
  });

  it("a crash loop switches to passthrough, then tries again after passthroughMs", async () => {
    let calls = 0;
    const good = fakeWorker();
    const s = make(() => (++calls <= 3 ? Promise.reject(new Error("crash")) : Promise.resolve(good)), { passthroughMs: 120 });
    await s.start();
    await waitFor(() => s.snapshot().state === "passthrough", { what: "passthrough" });
    assert.equal(s.workerOrigin(), null);
    assert.equal(calls, 3);
    await sleep(40);
    assert.equal(calls, 3, "must not retry before passthroughMs");
    await waitFor(() => s.snapshot().state === "up", { what: "recovery" });
    assert.equal(calls, 4);
    await s.stop();
  });

  it("kills a worker that stops answering liveness probes, then restarts it", async () => {
    const first = fakeWorker();
    const workers = [first];
    const s = make(() => Promise.resolve(workers.shift() ?? fakeWorker()), {}, (port) => (port === first.port ? new Promise<boolean>(() => undefined) : Promise.resolve(true)));
    await s.start();
    await waitFor(() => first.signals.includes("SIGKILL"), { what: "SIGKILL of the hung worker" });
    await waitFor(() => s.snapshot().port !== null && s.snapshot().port !== first.port, { what: "replacement" });
    await s.stop();
  });

  it("one successful probe resets the miss counter", async () => {
    const w = fakeWorker();
    let n = 0;
    const s = make(() => Promise.resolve(w), { probeMissLimit: 2 }, () => Promise.resolve(++n % 2 === 0)); // fail, ok, fail, ok...
    await s.start();
    await waitFor(() => n >= 8, { what: "8 probes" });
    assert.equal(w.signals.length, 0);
    await s.stop();
  });

  it("stop() terminates the worker and nothing restarts afterwards", async () => {
    const w = fakeWorker();
    let spawns = 0;
    const s = make(() => {
      spawns++;
      return Promise.resolve(w);
    });
    await s.start();
    await s.stop();
    assert.deepEqual(w.signals, ["SIGTERM"]);
    assert.equal(s.snapshot().state, "stopped");
    assert.equal(s.workerOrigin(), null);
    await sleep(80);
    assert.equal(spawns, 1);
  });

  it("a worker that was up for stableResetMs does not count toward the crash loop", async () => {
    // With crashLimit 2, two quick crashes would enter passthrough. Long, stable lives in between must prevent that.
    let clock = 0;
    const created: FakeWorker[] = [];
    const s = make(
      () => {
        const w = fakeWorker();
        created.push(w);
        return Promise.resolve(w);
      },
      { stableResetMs: 1000, crashLimit: 2, backoffInitialMs: 10 },
      () => Promise.resolve(true),
      () => clock,
    );
    await s.start();
    for (let i = 0; i < 3; i++) {
      clock += 5000; // the current worker has been up far longer than stableResetMs
      (created.at(-1) as FakeWorker).crash();
      await waitFor(() => created.length === i + 2 && s.snapshot().state === "up", { what: `restart ${i}` });
    }
    assert.equal(s.snapshot().restarts, 3);
    await s.stop();
  });

  it("without stable lives, the same crashes DO trigger passthrough (control for the test above)", async () => {
    let clock = 0;
    const created: FakeWorker[] = [];
    const s = make(
      () => {
        const w = fakeWorker();
        created.push(w);
        return Promise.resolve(w);
      },
      { stableResetMs: 1000, crashLimit: 2, backoffInitialMs: 10, passthroughMs: 5000 },
      () => Promise.resolve(true),
      () => clock,
    );
    await s.start();
    (created.at(-1) as FakeWorker).crash(); // crash 1 at t=0
    await waitFor(() => created.length === 2 && s.snapshot().state === "up");
    clock += 100; // still inside stableResetMs
    (created.at(-1) as FakeWorker).crash(); // crash 2
    await waitFor(() => s.snapshot().state === "passthrough", { what: "passthrough" });
    await s.stop();
  });
});
