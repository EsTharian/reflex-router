// Run in a forked child by no-network.test.ts to prove the guard is inherited by child processes.
import net from "node:net";

try {
  net.connect(80, "example.com").on("error", () => undefined);
  process.stdout.write("NOT-GUARDED\n");
} catch (e) {
  process.stdout.write(`GUARDED ${(e as Error).message}\n`);
}
process.exit(0);
