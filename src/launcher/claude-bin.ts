import fs from "node:fs";
import path from "node:path";

export interface ResolvedBin {
  readonly path: string;
  /** Windows .cmd/.bat shims need a shell to run. */
  readonly needsShell: boolean;
}

export interface ResolveIO {
  readonly platform: NodeJS.Platform;
  readonly pathEnv: string | undefined;
  readonly pathExt: string | undefined;
  readonly isExecutable: (file: string) => boolean;
}

export const realResolveIO = (env: NodeJS.ProcessEnv): ResolveIO => ({
  platform: process.platform,
  pathEnv: env["PATH"] ?? env["Path"],
  pathExt: env["PATHEXT"],
  isExecutable: (file) => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      if (process.platform === "win32") return true;
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
});

const needsShell = (file: string, platform: NodeJS.Platform): boolean => platform === "win32" && /\.(cmd|bat)$/i.test(file);

/**
 * Finds the real `claude`. `override` (REFLEX_CLAUDE_BIN) may be a path or a command name.
 * Returns null when nothing executable is found.
 */
export function resolveClaude(override: string | undefined, io: ResolveIO): ResolvedBin | null {
  const p = io.platform === "win32" ? path.win32 : path.posix;
  const name = override ?? "claude";
  const exts = io.platform === "win32" ? (io.pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [];
  const variants = (base: string): string[] => (io.platform === "win32" && p.extname(base) === "" ? [base, ...exts.map((e) => base + e.toLowerCase()), ...exts.map((e) => base + e)] : [base]);

  const hasDir = name.includes("/") || (io.platform === "win32" && name.includes("\\"));
  const dirs = hasDir ? [""] : (io.pathEnv ?? "").split(io.platform === "win32" ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of variants(dir === "" ? name : p.join(dir, name))) {
      if (io.isExecutable(candidate)) return { path: candidate, needsShell: needsShell(candidate, io.platform) };
    }
  }
  return null;
}
