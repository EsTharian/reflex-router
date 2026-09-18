// Module boundaries from the plan, enforced: only src/wire/ knows Claude Code / Anthropic body shapes, and only
// src/config.ts reads process.env.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
const sources = walk("src");

describe("module boundaries", () => {
  it("request/response body shapes are only known in src/wire/", () => {
    const shape = /tool_result|\.messages\b|\["messages"\]|cc_is_subagent|billing-header|message_delta|message_start|system-reminder|x-claude-code-/;
    const offenders = sources.filter((f) => !f.startsWith(path.join("src", "wire") + path.sep) && shape.test(fs.readFileSync(f, "utf8")));
    assert.deepEqual(offenders, []);
  });

  it("process.env is only read in src/config.ts (the launcher passes env to children explicitly)", () => {
    const allowed = new Set([path.join("src", "config.ts"), path.join("src", "launcher", "launch.ts")]);
    const offenders = sources.filter((f) => !allowed.has(f) && /process\.env\b/.test(fs.readFileSync(f, "utf8")));
    assert.deepEqual(offenders, []);
  });

  it("the decision backend never sees a RequestView", () => {
    for (const f of walk(path.join("src", "backend"))) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /RequestView|wire\//, f);
  });
});
