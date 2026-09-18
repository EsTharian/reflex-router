import type { Config } from "./config.js";
import type { EffectiveMode } from "./effective-mode.js";

/** launcher -> worker, sent once right after fork. */
export interface InitMessage {
  readonly type: "init";
  readonly config: Config;
  readonly effectiveMode: EffectiveMode;
  readonly degradedReason: string | null;
  readonly claudeVersion: string | null;
}

/** worker -> launcher, sent once the worker is listening. */
export interface ReadyMessage {
  readonly type: "ready";
  readonly port: number;
}

/** launcher -> worker: finish in-flight work and exit. */
export interface ShutdownMessage {
  readonly type: "shutdown";
}

export type LauncherMessage = InitMessage | ShutdownMessage;
export type WorkerMessage = ReadyMessage;

export const isLauncherMessage = (m: unknown): m is LauncherMessage =>
  typeof m === "object" && m !== null && ["init", "shutdown"].includes((m as { type?: unknown }).type as string);
