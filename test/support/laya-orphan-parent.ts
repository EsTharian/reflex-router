// Started by laya.test.ts: starts laya-serve (the fake) the way the launcher does, reports once it is ready, then idles
// until it is SIGKILLed by the test.
import { startLaya } from "../../src/launcher/laya.js";

const [bin, report] = process.argv.slice(2);
const laya = await startLaya({ bin: { path: bin ?? "", needsShell: false }, env: { PATH: process.env["PATH"], FAKE_LAYA_REPORT: report }, model: "english", readyTimeoutMs: 10_000, logFile: null, pollMs: 50 });
process.send?.({ ready: await laya.ready });
setInterval(() => undefined, 1000);
