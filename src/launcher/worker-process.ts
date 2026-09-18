import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InitMessage, WorkerMessage } from "../ipc.js";
import type { Log } from "../util/log.js";
import type { SpawnedWorker } from "./supervisor.js";

/** The worker entry next to this module, as .js when built and as .ts when run through tsx (tests). */
export function workerEntry(): string {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`../worker/main${ext}`, import.meta.url));
}

const MAX_LOG_BYTES = 512 * 1024;

/** Opens ~/.reflex/worker.log (0600) for appending; truncates it first if it has grown too large. */
export function openWorkerLog(home: string): fs.WriteStream | null {
  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = path.join(home, "worker.log");
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.truncateSync(file, 0);
    } catch {
      // does not exist yet
    }
    return fs.createWriteStream(file, { flags: "a", mode: 0o600 });
  } catch {
    return null;
  }
}

export interface SpawnWorkerProcessOptions {
  readonly init: InitMessage;
  readonly entry?: string;
  readonly readyTimeoutMs: number;
  readonly logFile: fs.WriteStream | null;
  readonly log: Log;
}

/** Starts the worker as a child process and resolves once it reports the port it listens on. */
export function spawnWorkerProcess(opts: SpawnWorkerProcessOptions): Promise<SpawnedWorker> {
  return new Promise((resolve, reject) => {
    const child = fork(opts.entry ?? workerEntry(), [], { stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "json" });
    child.stderr?.on("data", (c: Buffer) => opts.logFile?.write(c));

    let ready = false;
    const exited = new Promise<void>((res) => child.once("exit", () => res()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`worker not ready after ${opts.readyTimeoutMs} ms`));
    }, opts.readyTimeoutMs);

    child.on("message", (m: unknown) => {
      const msg = m as WorkerMessage;
      if (msg?.type !== "ready" || ready) return;
      ready = true;
      clearTimeout(timer);
      resolve({ port: msg.port, exited, kill: (signal) => void child.kill(signal ?? "SIGTERM") });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (!ready) reject(new Error(`worker exited before it was ready (code ${String(code)}, signal ${String(signal)})`));
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      if (!ready) reject(e);
    });
    child.send(opts.init, (err) => {
      if (err) opts.log("warn", `could not send init to worker: ${err.message}`);
    });
  });
}

