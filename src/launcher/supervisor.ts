// Keeps one worker alive and tells the front door where it is. It never throws into the launcher: whatever goes
// wrong, workerOrigin() just returns null and the front door forwards straight to the upstream.
import { noopLog, type Log } from "../util/log.js";

export interface Timings {
  readonly readyTimeoutMs: number;
  readonly probeIntervalMs: number;
  readonly probeTimeoutMs: number;
  /** Consecutive failed liveness probes before the worker is killed. */
  readonly probeMissLimit: number;
  readonly backoffInitialMs: number;
  readonly backoffMaxMs: number;
  /** A worker that stayed up this long resets the crash counter and backoff. */
  readonly stableResetMs: number;
  readonly crashWindowMs: number;
  /** This many crashes inside crashWindowMs switch to passthrough-only. */
  readonly crashLimit: number;
  readonly passthroughMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  readyTimeoutMs: 5000,
  probeIntervalMs: 2000,
  probeTimeoutMs: 1000,
  probeMissLimit: 3,
  backoffInitialMs: 200,
  backoffMaxMs: 5000,
  stableResetMs: 60_000,
  crashWindowMs: 60_000,
  crashLimit: 3,
  passthroughMs: 60_000,
};

export interface SpawnedWorker {
  readonly port: number;
  /** Resolves when the process is gone, for any reason. */
  readonly exited: Promise<void>;
  kill(signal?: NodeJS.Signals): void;
}

/** Resolves once the worker is ready to serve; rejects if it dies or is not ready in time. */
export type SpawnWorker = () => Promise<SpawnedWorker>;

export type SupervisorState = "starting" | "up" | "restarting" | "passthrough" | "stopped";

export interface SupervisorSnapshot {
  readonly state: SupervisorState;
  readonly restarts: number;
  readonly lastFailureAt: number | null;
  readonly port: number | null;
}

/** Counts events inside a sliding window. Pure; time is passed in. */
export class CrashTracker {
  private times: number[] = [];
  constructor(private readonly windowMs: number) {}
  record(now: number): void {
    this.times.push(now);
    this.prune(now);
  }
  count(now: number): number {
    this.prune(now);
    return this.times.length;
  }
  clear(): void {
    this.times = [];
  }
  private prune(now: number): void {
    this.times = this.times.filter((t) => now - t < this.windowMs);
  }
}

export interface SupervisorDeps {
  readonly spawnWorker: SpawnWorker;
  readonly probe: (port: number) => Promise<boolean>;
  readonly timings?: Partial<Timings>;
  readonly now?: () => number;
  readonly log?: Log;
}

export class Supervisor {
  private readonly t: Timings;
  private readonly now: () => number;
  private readonly log: Log;
  private readonly crashes: CrashTracker;
  private state: SupervisorState = "starting";
  private worker: SpawnedWorker | null = null;
  private upSince: number | null = null;
  private backoffMs: number;
  private restarts = 0;
  private lastFailureAt: number | null = null;
  private misses = 0;
  private probeTimer: NodeJS.Timeout | undefined;
  private restartTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: SupervisorDeps) {
    this.t = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? noopLog;
    this.crashes = new CrashTracker(this.t.crashWindowMs);
    this.backoffMs = this.t.backoffInitialMs;
  }

  /** Makes the first attempt. Resolves when it has succeeded or failed; failures schedule retries by themselves. */
  async start(): Promise<void> {
    await this.attempt();
  }

  workerOrigin(): URL | null {
    return this.state === "up" && this.worker ? new URL(`http://127.0.0.1:${this.worker.port}`) : null;
  }

  snapshot(): SupervisorSnapshot {
    return { state: this.state, restarts: this.restarts, lastFailureAt: this.lastFailureAt, port: this.worker?.port ?? null };
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    clearTimeout(this.restartTimer);
    clearInterval(this.probeTimer);
    const w = this.worker;
    this.worker = null;
    if (!w) return;
    w.kill("SIGTERM");
    const escalate = setTimeout(() => w.kill("SIGKILL"), 2000);
    await w.exited;
    clearTimeout(escalate);
  }

  /** A getter (not a comparison) so control-flow narrowing does not hide that stop() can run during an await. */
  private get stopped(): boolean {
    return this.state === "stopped";
  }

  private async attempt(): Promise<void> {
    if (this.stopped) return;
    let w: SpawnedWorker;
    try {
      w = await this.deps.spawnWorker();
    } catch (e) {
      this.onFailure(`spawn failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (this.stopped) {
      w.kill("SIGTERM");
      return;
    }
    this.worker = w;
    this.upSince = this.now();
    this.misses = 0;
    this.state = "up";
    this.log("info", `worker up on port ${w.port}`);
    this.startProbing(w);
    void w.exited.then(() => {
      if (this.worker !== w) return;
      this.worker = null;
      clearInterval(this.probeTimer);
      if (!this.stopped) this.onFailure("worker exited");
    });
  }

  private startProbing(w: SpawnedWorker): void {
    clearInterval(this.probeTimer);
    this.probeTimer = setInterval(() => {
      void this.probeOnce(w);
    }, this.t.probeIntervalMs);
    this.probeTimer.unref();
  }

  private async probeOnce(w: SpawnedWorker): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const ok = await Promise.race([
      this.deps.probe(w.port).catch(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.t.probeTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (this.worker !== w) return; // replaced or stopped while probing
    if (ok) {
      this.misses = 0;
      return;
    }
    this.misses++;
    this.log("warn", `worker liveness probe failed (${this.misses}/${this.t.probeMissLimit})`);
    if (this.misses >= this.t.probeMissLimit) {
      this.log("error", "worker is not responding; killing it");
      w.kill("SIGKILL"); // its exit is handled like any other crash
    }
  }

  private onFailure(reason: string): void {
    const now = this.now();
    if (this.upSince !== null && now - this.upSince >= this.t.stableResetMs) {
      this.backoffMs = this.t.backoffInitialMs;
      this.crashes.clear();
    }
    this.upSince = null;
    this.crashes.record(now);
    this.lastFailureAt = now;
    this.restarts++;
    if (this.crashes.count(now) >= this.t.crashLimit) {
      this.state = "passthrough";
      this.crashes.clear();
      this.backoffMs = this.t.backoffInitialMs;
      this.log("error", `${reason}; crash loop, passing traffic straight through for ${this.t.passthroughMs} ms`);
      this.schedule(this.t.passthroughMs);
      return;
    }
    this.state = "restarting";
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.t.backoffMaxMs);
    this.log("warn", `${reason}; restarting in ${delay} ms`);
    this.schedule(delay);
  }

  private schedule(ms: number): void {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      void this.attempt();
    }, ms);
    this.restartTimer.unref();
  }
}
