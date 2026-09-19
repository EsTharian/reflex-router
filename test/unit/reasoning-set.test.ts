import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REASONING_SET } from "../live/reasoning-set.js";

describe("the live reasoning-vs-length prompt set", () => {
  it("has 30 unique prompts, six per cell, each within the decision backend's text budget", () => {
    assert.equal(REASONING_SET.length, 30);
    assert.equal(new Set(REASONING_SET.map((p) => p.id)).size, 30);
    for (const cell of ["short-hard", "long-easy", "short-easy", "long-hard", "mid"]) assert.equal(REASONING_SET.filter((p) => p.cell === cell).length, 6, cell);
    for (const p of REASONING_SET) assert.ok(p.task.length <= 4000, `${p.id} is ${p.task.length} chars (REFLEX_MAX_USER_CHARS default 4000)`);
  });
  it("its discordant cells really are discordant: short-hard prompts are shorter than long-easy ones, labelled the other way round", () => {
    const len = (cell: string): number[] => REASONING_SET.filter((p) => p.cell === cell).map((p) => p.task.length);
    assert.ok(Math.max(...len("short-hard")) < Math.min(...len("long-easy")));
    assert.ok(REASONING_SET.filter((p) => p.cell === "short-hard").every((p) => p.label === "opus" && p.length === "short"));
    assert.ok(REASONING_SET.filter((p) => p.cell === "long-easy").every((p) => p.label === "haiku" && p.length === "long"));
  });
});
