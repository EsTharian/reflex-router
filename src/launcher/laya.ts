// The launcher's own `laya-serve` (REFLEX_BACKEND=laya): started on a free loopback port with a per-session key,
// offline (Hugging Face cache only), through laya-guard so it cannot outlive the launcher. claude does not wait for
// it: until the model is loaded, decisions fail fast (connection refused) and every request goes out unchanged.
import { fork, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import type fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { forward } from "../net/forward.js";
import type { ResolvedBin } from "./claude-bin.js";

export interface LayaServer {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Resolves true once /health reports the model loaded, false if it never did (the server is then stopped). */
  readonly ready: Promise<boolean>;
  stop(): Promise<void>;
}

const guardEntry = (): string => fileURLToPath(new URL(`./laya-guard${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url));

/** A free loopback port. It is released before laya-serve binds it; losing that race means laya exits, i.e. fail-open. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

/**
 * laya-serve's environment: the user's, minus reflex's settings (the caller passes sanitizedEnv) and anything
 * Anthropic's, plus what pins it to loopback (its own default is 0.0.0.0), to this session's key, to the one checkpoint
 * reflex asks for, and to the local Hugging Face cache (no connection to the Hub). LAYA_THREADS/LAYA_DEVICE pass through.
 */
export function layaEnv(env: NodeJS.ProcessEnv, port: number, apiKey: string, model: Config["layaModel"]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith("ANTHROPIC_")) out[k] = v;
  return {
    ...out,
    LAYA_HOST: "127.0.0.1",
    LAYA_PORT: String(port),
    LAYA_API_KEY: apiKey,
    LAYA_PRELOAD: "1",
    LAYA_MODELS: model,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
  };
}

/** laya-serve's /health lists the checkpoints it has loaded (`{"loaded": ["english"]}`); `true` is accepted too. */
async function loaded(baseUrl: string, apiKey: string, model: string): Promise<boolean> {
  try {
    const res = await forward(new URL(baseUrl), { method: "GET", url: "/health", headers: { authorization: `Bearer ${apiKey}` }, body: Buffer.alloc(0) }, { connectTimeoutMs: 500 });
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const l = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { loaded?: unknown }).loaded;
    return res.statusCode === 200 && (l === true || (Array.isArray(l) && l.includes(model)));
  } catch {
    return false;
  }
}

export interface StartLayaOptions {
  readonly bin: ResolvedBin;
  /** The environment to start from; already without reflex settings or the TYPESAFE key (sanitizedEnv). */
  readonly env: NodeJS.ProcessEnv;
  readonly model: Config["layaModel"];
  readonly readyTimeoutMs: number;
  readonly logFile: fs.WriteStream | null;
  readonly pollMs?: number;
}

export async function startLaya(opts: StartLayaOptions): Promise<LayaServer> {
  const port = await freePort();
  const apiKey = crypto.randomBytes(32).toString("hex");
  const baseUrl = `http://127.0.0.1:${port}`;
  const log = (m: string): void => void opts.logFile?.write(`${new Date().toISOString()} laya: ${m}\n`);
  const guard: ChildProcess = fork(guardEntry(), [opts.bin.path, opts.bin.needsShell ? "1" : "0"], {
    env: layaEnv(opts.env, port, apiKey, opts.model),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const toLog = (c: Buffer): void => void opts.logFile?.write(c.toString("utf8").replace(/^(?=.)/gm, "laya: "));
  guard.stdout?.on("data", toLog);
  guard.stderr?.on("data", toLog);
  guard.on("error", (e) => log(`guard error: ${e.message}`));
  const exited = new Promise<void>((res) => guard.once("exit", () => res()));
  let gone = false;
  let stopped = false;
  void exited.then(() => (gone = true));

  const stop = async (): Promise<void> => {
    stopped = true;
    if (guard.connected) guard.disconnect(); // the guard stops laya-serve, then exits
    const t = setTimeout(() => guard.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(t);
  };

  const started = Date.now();
  const ready = (async (): Promise<boolean> => {
    while (!gone && Date.now() - started < opts.readyTimeoutMs) {
      if (await loaded(baseUrl, apiKey, opts.model)) {
        log(`${opts.model} loaded after ${Date.now() - started} ms on ${baseUrl}`);
        return true;
      }
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 500).unref());
    }
    if (stopped) return false;
    log(gone ? "laya-serve exited before it was ready; this session runs without decisions" : `not ready after ${opts.readyTimeoutMs} ms; stopping it`);
    await stop();
    return false;
  })();
  return { baseUrl, apiKey, ready, stop };
}
