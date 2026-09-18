import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assessVersion, describeVerdict, parseVersion, probeClaudeVersion } from "../../src/launcher/version.js";

const FAKE_CLAUDE = fileURLToPath(new URL("../support/fake-claude.mjs", import.meta.url));
const bin = { path: FAKE_CLAUDE, needsShell: false };

describe("parseVersion", () => {
  it("finds the first MAJOR.MINOR.PATCH in real-world output", () => {
    assert.deepEqual(parseVersion("2.1.277 (Claude Code)"), { major: 2, minor: 1, patch: 277 });
    assert.deepEqual(parseVersion("v3.0.0-beta.1"), { major: 3, minor: 0, patch: 0 });
    assert.deepEqual(parseVersion("claude-cli/2.1.277 (external, sdk-cli)"), { major: 2, minor: 1, patch: 277 });
  });
  it("returns null for anything without three numbers", () => {
    for (const v of [null, undefined, "", "hello", "2.1", "v2", "a.b.c"]) assert.equal(parseVersion(v), null, String(v));
  });
});

describe("assessVersion", () => {
  const tested = ["2.1.277"];
  const cases: [string | null, readonly string[], string, string][] = [
    ["2.1.277 (Claude Code)", tested, "ok", "exact_match"],
    ["2.1.278", tested, "warn", "minor_mismatch"],
    ["2.0.5", tested, "warn", "minor_mismatch"],
    ["2.9.0", tested, "warn", "minor_mismatch"],
    ["3.0.0", tested, "degrade", "major_mismatch"],
    ["1.9.9", tested, "degrade", "major_mismatch"],
    [null, tested, "warn", "unparseable"],
    ["garbage", tested, "warn", "unparseable"],
    ["2.1.277", [], "warn", "no_tested_versions"],
    ["2.5.0", ["2.1.277", "2.4.1"], "warn", "minor_mismatch"],
    ["3.0.1", ["2.1.277", "3.0.0"], "warn", "minor_mismatch"],
    ["2.4.1", ["2.1.277", "2.4.1"], "ok", "exact_match"],
  ];
  for (const [running, list, level, reason] of cases) {
    it(`${JSON.stringify(running)} vs [${list.join(", ")}] -> ${level} (${reason})`, () => {
      const v = assessVersion(running, list);
      assert.equal(v.level, level);
      assert.equal(v.reason, reason);
    });
  }

  it("only a major mismatch ever degrades: a minor mismatch alone warns", () => {
    for (const r of ["2.1.278", "2.2.0", "2.99.99"]) assert.equal(assessVersion(r, tested).level, "warn", r);
  });
});

describe("describeVerdict", () => {
  it("is silent for an exact match and explains everything else", () => {
    assert.equal(describeVerdict(assessVersion("2.1.277", ["2.1.277"])), null);
    assert.match(describeVerdict(assessVersion("2.1.300", ["2.1.277"])) ?? "", /2\.1\.300.*2\.1\.277/);
    // the raw `--version` line ("2.1.300 (Claude Code)") must not be repeated verbatim in the message
    assert.doesNotMatch(describeVerdict(assessVersion("2.1.300 (Claude Code)", ["2.1.277"])) ?? "", /\(Claude Code\)/);
    assert.match(describeVerdict(assessVersion("3.0.0", ["2.1.277"])) ?? "", /only recorded|never applied/);
    assert.match(describeVerdict(assessVersion("???", ["2.1.277"])) ?? "", /could not determine/);
  });
});

describe("probeClaudeVersion", () => {
  it("returns the first output line of `claude --version`", async () => {
    assert.equal(await probeClaudeVersion(bin, { ...process.env, FAKE_CLAUDE_VERSION: "2.7.1 (Claude Code)" }), "2.7.1 (Claude Code)");
  });
  it("returns null when the command hangs, and does so within the timeout", async () => {
    const t0 = Date.now();
    assert.equal(await probeClaudeVersion(bin, { ...process.env, FAKE_CLAUDE_HANG_VERSION: "1" }, 300), null);
    assert.ok(Date.now() - t0 < 3000);
  });
  it("returns null when the binary does not exist", async () => {
    assert.equal(await probeClaudeVersion({ path: path.join("/nonexistent", "claude"), needsShell: false }, process.env), null);
  });
});
