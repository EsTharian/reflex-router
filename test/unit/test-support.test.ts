// The integration tests read decisions.jsonl while the worker may still be appending to it (a CI run on ubuntu / Node 20
// once parsed a half-written last line: "Unterminated string in JSON"). The helper must only see complete lines.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { allRecords } from "../support/replay.js";
import type { Stack } from "../support/stack.js";

const stackWith = (content: string): Stack => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reflex-replay-"));
  fs.writeFileSync(path.join(home, "decisions.jsonl"), content);
  return { config: { home } } as unknown as Stack;
};

describe("allRecords (test helper)", () => {
  it("returns complete lines and ignores a last line the worker is still writing", () => {
    const full = JSON.stringify({ record: "decision", id: "b", pad: "x".repeat(900) });
    const torn = full.slice(0, 954 > full.length ? full.length - 5 : 954);
    const recs = allRecords(stackWith(`${JSON.stringify({ record: "decision", id: "a" })}\n${torn}`));
    assert.deepEqual(recs.map((r) => r["id"]), ["a"]);
  });
  it("picks the record up once its newline has been written", () => {
    const line = JSON.stringify({ record: "decision", id: "b" });
    assert.equal(allRecords(stackWith(`${line}\n`)).length, 1);
    assert.equal(allRecords(stackWith("")).length, 0);
  });
});
