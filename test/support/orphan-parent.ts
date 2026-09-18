// Started by door-worker.test.ts: spawns a worker, reports its pid, then idles until it is SIGKILLed by the test.
import type { Config } from "../../src/config.js";
import { spawnWorkerProcess } from "../../src/launcher/worker-process.js";

const config = JSON.parse(process.argv[2] ?? "{}") as Config;
const pidOf = async (port: number): Promise<number> => {
  const res = await fetch(`http://127.0.0.1:${port}/__reflex/health`);
  return ((await res.json()) as { pid: number }).pid;
};
const w = await spawnWorkerProcess({ init: { type: "init", config, effectiveMode: "shadow", degradedReason: null, claudeVersion: null }, readyTimeoutMs: 15_000, logFile: null, log: () => undefined });
process.send?.({ workerPid: await pidOf(w.port) });
setInterval(() => undefined, 1000);
