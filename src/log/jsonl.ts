// Append-only JSONL writer for ~/.reflex: directory 0700, files 0600, size-rotated (file -> file.1 -> … -> file.N).
// Appends are serialised; a failed write is reported to `onError` and never thrown at the caller.
import fs from "node:fs/promises";
import path from "node:path";

export interface JsonlOptions {
  readonly maxBytes?: number;
  readonly keep?: number;
  readonly onError?: (e: Error) => void;
}

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_KEEP = 5;

export class JsonlWriter {
  #queue: Promise<void> = Promise.resolve();
  #size: number | null = null;

  constructor(
    readonly file: string,
    private readonly opts: JsonlOptions = {},
  ) {}

  append(record: unknown): Promise<void> {
    const line = JSON.stringify(record) + "\n";
    this.#queue = this.#queue.then(() => this.#write(line)).catch((e: unknown) => this.opts.onError?.(e instanceof Error ? e : new Error(String(e))));
    return this.#queue;
  }

  /** Resolves once every append issued so far has been written (or failed). */
  flush(): Promise<void> {
    return this.#queue;
  }

  async #write(line: string): Promise<void> {
    const max = this.opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (this.#size === null) {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      this.#size = await fs.stat(this.file).then((s) => s.size, () => 0);
    }
    const bytes = Buffer.byteLength(line);
    if (this.#size > 0 && this.#size + bytes > max) {
      await this.#rotate();
      this.#size = 0;
    }
    await fs.appendFile(this.file, line, { mode: 0o600 });
    this.#size += bytes;
  }

  async #rotate(): Promise<void> {
    const keep = this.opts.keep ?? DEFAULT_KEEP;
    await fs.rm(`${this.file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) await fs.rename(`${this.file}.${i}`, `${this.file}.${i + 1}`).catch(() => undefined);
    await fs.rename(this.file, `${this.file}.1`).catch(() => undefined);
  }
}
