// The launcher's own laya-serve (src/launcher/laya.ts), against a fake laya-serve: loopback, offline, a per-session
// key, no reflex/TypeSafe/Anthropic variables, and it never outlives the launcher.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startLaya } from "../../src/launcher/laya.js";
import { waitFor } from "../support/http.js";

const FAKE_LAYA = fileURLToPath(new URL("../support/fake-laya-serve.mjs", import.meta.url));
fs.chmodSync(FAKE_LAYA, 0o755);

interface LayaReport {
  pid: number;
  env: Record<string, string | null>;
  hasApiKey: boolean;
  leaked: string[];
  health: { auth: boolean; loaded: boolean }[];
}

const tmpReport = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reflex-laya-")), "report.json");
const readReport = (file: string): LayaReport | null => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as LayaReport;
  } catch {
    return null;
  }
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const start = (report: string, env: NodeJS.ProcessEnv = {}, readyTimeoutMs = 10_000) =>
  startLaya({ bin: { path: FAKE_LAYA, needsShell: false }, env: { PATH: process.env["PATH"], FAKE_LAYA_REPORT: report, ANTHROPIC_API_KEY: "sk-ant-user", ANTHROPIC_BASE_URL: "http://x", ...env }, model: "multilingual", readyTimeoutMs, logFile: null, pollMs: 50 });

describe("laya-serve managed by the launcher", () => {
  it("binds loopback only, offline, with a session key and one checkpoint; no Anthropic variables; stops with the launcher", async () => {
    const file = tmpReport();
    const laya = await start(file, { FAKE_LAYA_LOAD_MS: "200" });
    assert.match(laya.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(laya.apiKey.length, 64);
    assert.equal(await laya.ready, true);
    const r = readReport(file);
    assert.ok(r);
    assert.deepEqual(r.env, { LAYA_HOST: "127.0.0.1", LAYA_PORT: new URL(laya.baseUrl).port, LAYA_PRELOAD: "1", LAYA_MODELS: "multilingual", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" });
    assert.equal(r.hasApiKey, true);
    assert.deepEqual(r.leaked, []);
    assert.ok(r.health.some((h) => !h.loaded), "polled while loading");
    assert.ok(r.health.every((h) => h.auth));
    await laya.stop();
    await waitFor(() => !alive(r.pid), { timeoutMs: 5000, what: "laya-serve to exit" });
  });

  it("a server that never loads is stopped at the ready timeout", async () => {
    const file = tmpReport();
    const laya = await start(file, { FAKE_LAYA_NEVER_READY: "1" }, 1000);
    assert.equal(await laya.ready, false);
    const r = readReport(file);
    assert.ok(r);
    await waitFor(() => !alive(r.pid), { timeoutMs: 5000, what: "laya-serve to exit" });
  });

  it("a missing binary resolves ready=false without throwing", async () => {
    const laya = await startLaya({ bin: { path: "/nonexistent/laya-serve", needsShell: false }, env: {}, model: "english", readyTimeoutMs: 5000, logFile: null, pollMs: 50 });
    assert.equal(await laya.ready, false);
    await laya.stop();
  });

  it("exits by itself when the launcher is SIGKILLed (no orphaned model in memory)", async () => {
    const file = tmpReport();
    const parent = fork(fileURLToPath(new URL("../support/laya-orphan-parent.ts", import.meta.url)), [FAKE_LAYA, file], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const ready = await new Promise<boolean>((resolve, reject) => {
      parent.once("message", (m: unknown) => resolve((m as { ready: boolean }).ready));
      parent.once("exit", () => reject(new Error("parent exited early")));
    });
    assert.equal(ready, true);
    const r = readReport(file);
    assert.ok(r && alive(r.pid));
    parent.kill("SIGKILL");
    await waitFor(() => !alive(r.pid), { timeoutMs: 5000, what: "laya-serve to exit after the launcher died" });
  });
});
