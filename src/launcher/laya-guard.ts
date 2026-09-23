// Runs `laya-serve` for the launcher and dies with it. Python has no IPC channel to notice a `kill -9`'d launcher, so
// this small process holds one: when it closes (launcher gone, however) or on SIGTERM, laya-serve is stopped.
// argv: <laya-serve path> <"1" if it needs a shell>. The environment is laya-serve's, prepared by src/launcher/laya.ts.
import { spawn } from "node:child_process";

const [bin, shell] = process.argv.slice(2);
if (typeof process.send !== "function" || bin === undefined) {
  process.stderr.write("reflex laya-guard: must be started by the reflex launcher\n");
  process.exit(2);
}

// Its own process group: a terminal Ctrl-C reaches claude's group, never laya-serve; only this guard stops it.
const child = spawn(bin, [], { stdio: ["ignore", "inherit", "inherit"], shell: shell === "1", detached: true });
child.once("error", (e) => {
  process.stderr.write(`cannot start laya-serve: ${e.message}\n`);
  process.exit(127);
});
child.once("exit", (code, signal) => {
  process.stderr.write(`laya-serve exited (code ${String(code)}, signal ${String(signal)})\n`);
  process.exit(0);
});

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000); // uvicorn normally exits well before this
};
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", () => undefined); // Ctrl-C belongs to claude; the launcher decides when laya stops
