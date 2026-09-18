export type LogLevel = "debug" | "info" | "warn" | "error";
export type Log = (level: LogLevel, message: string) => void;

export const noopLog: Log = () => undefined;

/** Writes `[level] message` lines with an ISO timestamp; used by the worker (stderr is captured to a file). */
export const stderrLog: Log = (level, message) => {
  process.stderr.write(`${new Date().toISOString()} [${level}] ${message}\n`);
};
