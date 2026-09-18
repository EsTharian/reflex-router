import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveClaude, type ResolveIO } from "../../src/launcher/claude-bin.js";

const io = (over: Partial<ResolveIO> & { executables?: string[] } = {}): ResolveIO => {
  const exe = new Set(over.executables ?? []);
  return { platform: "linux", pathEnv: "/usr/local/bin:/home/u/.local/bin", pathExt: undefined, isExecutable: (f) => exe.has(f), ...over };
};

describe("resolveClaude (posix)", () => {
  it("returns the first executable `claude` on PATH", () => {
    const r = resolveClaude(undefined, io({ executables: ["/home/u/.local/bin/claude", "/usr/local/bin/claude"] }));
    assert.deepEqual(r, { path: "/usr/local/bin/claude", needsShell: false });
  });
  it("skips non-executable candidates", () => {
    assert.equal(resolveClaude(undefined, io({ executables: ["/home/u/.local/bin/claude"] }))?.path, "/home/u/.local/bin/claude");
  });
  it("returns null when nothing is found, or PATH is unset", () => {
    assert.equal(resolveClaude(undefined, io()), null);
    assert.equal(resolveClaude(undefined, io({ pathEnv: undefined, executables: ["/usr/local/bin/claude"] })), null);
  });
  it("an override containing a slash is used as a path, not searched on PATH", () => {
    assert.equal(resolveClaude("/opt/x/claude", io({ executables: ["/opt/x/claude", "/usr/local/bin/claude"] }))?.path, "/opt/x/claude");
    assert.equal(resolveClaude("/opt/x/claude", io({ executables: ["/usr/local/bin/claude"] })), null);
  });
  it("an override without a slash is a command name searched on PATH", () => {
    assert.equal(resolveClaude("claude-dev", io({ executables: ["/home/u/.local/bin/claude-dev"] }))?.path, "/home/u/.local/bin/claude-dev");
  });
});

describe("resolveClaude (windows)", () => {
  const win = (executables: string[]): ResolveIO => ({ platform: "win32", pathEnv: "C:\\bin;C:\\npm", pathExt: ".COM;.EXE;.BAT;.CMD", isExecutable: (f) => executables.includes(f) });
  it("tries PATHEXT extensions", () => {
    assert.deepEqual(resolveClaude(undefined, win(["C:\\bin\\claude.exe"])), { path: "C:\\bin\\claude.exe", needsShell: false });
  });
  it("marks .cmd and .bat shims as needing a shell", () => {
    assert.deepEqual(resolveClaude(undefined, win(["C:\\npm\\claude.cmd"])), { path: "C:\\npm\\claude.cmd", needsShell: true });
    assert.equal(resolveClaude(undefined, win(["C:\\npm\\claude.bat"]))?.needsShell, true);
  });
});
