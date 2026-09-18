import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { TESTED_CLAUDE_VERSIONS } from "../../src/wire/tested-versions.generated.js";

const FIXTURES = path.join("test", "fixtures", "claude-code");

describe("tested Claude Code versions", () => {
  it("the generated list matches the fixture directories (npm run gen:versions)", () => {
    const r = spawnSync(process.execPath, ["scripts/gen-tested-versions.mjs", "--check"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  it("every fixture directory has a manifest that names the same version", () => {
    const dirs = fs.readdirSync(FIXTURES).filter((d) => /^\d+\.\d+\.\d+$/.test(d));
    assert.ok(dirs.length > 0);
    assert.deepEqual([...TESTED_CLAUDE_VERSIONS].sort(), dirs.sort());
    for (const d of dirs) {
      const m = JSON.parse(fs.readFileSync(path.join(FIXTURES, d, "manifest.json"), "utf8")) as { claude_code_version: string; files: { file: string }[] };
      assert.equal(m.claude_code_version, d);
      for (const f of m.files) assert.ok(fs.existsSync(path.join(FIXTURES, d, f.file)), `${d}/${f.file} listed but missing`);
    }
  });
});
