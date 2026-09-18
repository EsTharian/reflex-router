import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { route } from "../../src/cli.js";

describe("route", () => {
  it("forwards everything that is not a reflex subcommand to claude, untouched", () => {
    for (const argv of [[], ["-p", "hello"], ["--model", "sonnet", "fix it"], ["mcp", "list"], ["--version"], ["--help"], ["--resume"], ["Report", "x"]]) {
      assert.deepEqual(route(argv), { kind: "claude", args: argv });
    }
  });
  it("owns doctor, version and report only when they are the first argument", () => {
    assert.deepEqual(route(["doctor"]), { kind: "reflex", command: "doctor", args: [] });
    assert.deepEqual(route(["report", "--since", "2h"]), { kind: "reflex", command: "report", args: ["--since", "2h"] });
    assert.deepEqual(route(["version"]), { kind: "reflex", command: "version", args: [] });
    assert.deepEqual(route(["-p", "doctor"]), { kind: "claude", args: ["-p", "doctor"] });
  });
  it("`reflex --version` is claude's version, not ours", () => {
    assert.equal(route(["--version"]).kind, "claude");
  });
  it("`--` forces forwarding, even of reserved words", () => {
    assert.deepEqual(route(["--", "doctor"]), { kind: "claude", args: ["doctor"] });
    assert.deepEqual(route(["--"]), { kind: "claude", args: [] });
  });
});
