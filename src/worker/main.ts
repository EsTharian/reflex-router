// Entry point of the worker child process. Started (forked) by the launcher, which sends an `init` message.
import { isLauncherMessage } from "../ipc.js";
import { stderrLog } from "../util/log.js";
import { startWorkerServer, type WorkerServer } from "./server.js";

if (typeof process.send !== "function") {
  process.stderr.write("reflex worker: must be started by the reflex launcher\n");
  process.exit(2);
}

let server: WorkerServer | null = null;

const shutdown = (code: number): void => {
  const done = (): never => process.exit(code);
  if (server) void server.close().then(done, done);
  else done();
};

// If the launcher goes away for any reason (even kill -9), the IPC channel closes: do not linger as an orphan.
process.on("disconnect", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("uncaughtException", (e) => {
  stderrLog("error", `uncaught exception: ${e.stack ?? e.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  stderrLog("error", `unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});

process.on("message", (m: unknown) => {
  if (!isLauncherMessage(m)) return;
  if (m.type === "shutdown") {
    shutdown(0);
    return;
  }
  if (server) return;
  startWorkerServer({ config: m.config, effectiveMode: m.effectiveMode, degradedReason: m.degradedReason, claudeVersion: m.claudeVersion, log: stderrLog })
    .then((s) => {
      server = s;
      process.send?.({ type: "ready", port: s.port });
    })
    .catch((e: unknown) => {
      stderrLog("error", `could not start: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
});
