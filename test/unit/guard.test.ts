import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guard, type GuardInput } from "../../src/guard.js";
import { parseOverride } from "../../src/overrides.js";
import { cacheReadUsd, cacheWriteUsd, LAST_VERIFIED, PRICES } from "../../src/pricing.js";
import { isVerifiedRetarget } from "../../src/wire/rewrite.js";

const base: GuardInput = { cacheTier: "sonnet", to: "haiku", ctxTokens: 40_000, ttl: "1h", fresh: false, maxPenaltyUsd: 0.01 };

describe("pricing", () => {
  it("matches the pricing page as verified (per MTok) and carries the verification date", () => {
    assert.deepEqual(PRICES.haiku, { input: 1, output: 5, cacheReadMult: 0.1 });
    assert.deepEqual(PRICES.sonnet, { input: 2, output: 10, cacheReadMult: 0.1 });
    assert.deepEqual(PRICES.opus, { input: 5, output: 25, cacheReadMult: 0.1 });
    assert.deepEqual(PRICES.fable, { input: 10, output: 50, cacheReadMult: 0.025 });
    assert.match(LAST_VERIFIED, /^\d{4}-\d{2}-\d{2}$/);
  });
  it("cache write is 1.25x (5m) / 2x (1h) of input, read 0.1x (0.025x on Fable)", () => {
    assert.equal(cacheWriteUsd("haiku", 1_000_000, "5m"), 1.25);
    assert.equal(cacheWriteUsd("sonnet", 1_000_000, "1h"), 4);
    assert.ok(Math.abs(cacheReadUsd("sonnet", 1_000_000) - 0.2) < 1e-12);
    assert.ok(Math.abs(cacheReadUsd("fable", 1_000_000) - 0.25) < 1e-12);
  });
});

describe("guard", () => {
  it("a fresh conversation has nothing cached: allowed", () => {
    assert.deepEqual(guard({ ...base, fresh: true, ctxTokens: null, cacheTier: null }), { allowed: true, reason: "fresh", ctx: null, penaltyUsd: null });
  });
  it("staying on the tier that holds the cache costs nothing", () => {
    assert.equal(guard({ ...base, cacheTier: "haiku" }).reason, "no_switch");
  });
  it("unknown context refuses", () => {
    assert.deepEqual(guard({ ...base, ctxTokens: null }), { allowed: false, reason: "ctx_unknown", ctx: null, penaltyUsd: null });
  });
  it("penalty = write(to, ctx, ttl) - read(from, ctx); 40k context on the 1h main chat is over $0.01", () => {
    const r = guard(base);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "over_limit");
    assert.ok(Math.abs((r.penaltyUsd ?? 0) - (40_000 * 2 * 1 - 40_000 * 0.1 * 2) / 1e6) < 1e-12);
  });
  it("a small context passes; the limit is a ceiling", () => {
    assert.equal(guard({ ...base, ctxTokens: 5_000 }).allowed, true);
    const exact = (5_000 * 2 - 5_000 * 0.2) / 1e6;
    assert.equal(guard({ ...base, ctxTokens: 5_000, maxPenaltyUsd: exact + 1e-12 }).reason, "within_limit");
    assert.equal(guard({ ...base, ctxTokens: 5_000, maxPenaltyUsd: exact - 1e-9 }).reason, "over_limit");
  });
  it("uses the 5-minute write multiplier when the request has no 1h TTL", () => {
    const r = guard({ ...base, ttl: "5m", maxPenaltyUsd: 1 });
    assert.ok(Math.abs((r.penaltyUsd ?? 0) - (40_000 * 1.25 - 40_000 * 0.2) / 1e6) < 1e-12);
  });
});

describe("overrides", () => {
  it("a leading reflex:<tier> token, case-insensitive; anything else is not an override", () => {
    assert.equal(parseOverride("reflex:opus fix the race"), "opus");
    assert.equal(parseOverride("  REFLEX:Haiku list files"), "haiku");
    assert.equal(parseOverride("reflex:sonnet"), "sonnet");
    assert.equal(parseOverride("reflex:haiku\nnext line"), "haiku");
    for (const t of ["fix reflex:opus", "reflex:opuses", "reflex:fable x", "reflex: opus", "!haiku x", "", null]) assert.equal(parseOverride(t), null, String(t));
  });
});

describe("verified retargets", () => {
  it("only the downgrades verified against the API are applied: Sonnet -> Haiku, Opus -> Sonnet, Opus -> Haiku", () => {
    for (const [f, t] of [["sonnet", "haiku"], ["opus", "sonnet"], ["opus", "haiku"]] as const) assert.equal(isVerifiedRetarget(f, t), true);
    for (const [f, t] of [["haiku", "sonnet"], ["sonnet", "opus"], ["fable", "opus"], ["fable", "haiku"]] as const) assert.equal(isVerifiedRetarget(f, t), false);
  });
});
