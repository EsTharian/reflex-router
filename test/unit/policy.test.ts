import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, type Config, type Tier } from "../../src/config.js";
import { buildQuestions, judge, offeredTiers, plan, type PlanInput } from "../../src/policy.js";
import { tierOfModel } from "../../src/tiers.js";
import type { Decision, Judgement } from "../../src/types.js";

const cfg = (env: NodeJS.ProcessEnv = {}): Config => {
  const r = loadConfig(env);
  assert.ok(r.ok, r.ok ? "" : r.errors.join());
  return r.config;
};
const j = (tier: Tier, confidence: number, reasoning?: number): Judgement => ({
  tier: { value: tier, confidence, probabilities: { [tier]: confidence } },
  vetoes: reasoning === undefined ? {} : { reasoning_demand: reasoning },
});
const sub = (model: string): PlanInput => ({ kind: "subagent", requestedModel: model });

describe("tierOfModel", () => {
  it("maps model ids by family and returns null for unknown ones", () => {
    assert.equal(tierOfModel("claude-haiku-4-5-20251001"), "haiku");
    assert.equal(tierOfModel("claude-sonnet-5"), "sonnet");
    assert.equal(tierOfModel("claude-opus-5[1m]"), "opus");
    assert.equal(tierOfModel("claude-fable-5-1"), "fable");
    assert.equal(tierOfModel("gpt-5"), null);
    assert.equal(tierOfModel(null), null);
  });
});

describe("questions", () => {
  it("offer haiku/sonnet/opus, and fable only when explicitly allowed", () => {
    const q = buildQuestions(cfg());
    assert.equal(q["tier"]?.type, "choice");
    assert.deepEqual(Object.keys((q["tier"] as { criteria: object }).criteria), ["haiku", "sonnet", "opus"]);
    assert.deepEqual(offeredTiers(cfg({ REFLEX_ALLOW_FABLE: "1" })), ["haiku", "sonnet", "opus", "fable"]);
    const rd = q["reasoning_demand"];
    assert.ok(rd?.type === "score" && rd.criteria.length === 5);
  });

  it("tell the backend to judge reasoning, not length", () => {
    const text = JSON.stringify(buildQuestions(cfg())["tier"]);
    assert.match(text, /reasoning the task demands/);
    assert.match(text, /length of the message.*NOT the measure/);
  });
});

describe("judge", () => {
  const decision = (answers: Decision["answers"]): Decision => ({ answers, latencyMs: 1, backendModel: "m", tokensIn: 1 });
  const tierA = { type: "choice" as const, choice: "haiku", confidence: 0.8, probabilities: { haiku: 0.8, sonnet: 0.2 } };
  const rdA = { type: "score" as const, score: 0.7, confidence: 0.5, probabilities: {} };

  it("merges the tier pick and the reasoning_demand veto", () => {
    const r = judge(decision({ tier: tierA, reasoning_demand: rdA }), cfg());
    assert.ok(r.ok);
    assert.equal(r.judgement.tier.value, "haiku");
    assert.equal(r.judgement.vetoes["reasoning_demand"], 0.7);
  });

  it("a missing or mistyped answer, or a tier that was not offered, is an error (the caller fails open)", () => {
    assert.equal(judge(decision({ tier: tierA }), cfg()).ok, false);
    assert.equal(judge(decision({ tier: rdA, reasoning_demand: rdA }), cfg()).ok, false);
    assert.equal(judge(decision({ tier: { ...tierA, choice: "fable" }, reasoning_demand: rdA }), cfg()).ok, false);
  });
});

describe("plan (decision table)", () => {
  const c = cfg();
  const cases: [string, PlanInput, Judgement, Config, Tier | null, string[], boolean][] = [
    ["confident, low-demand downgrade to haiku", sub("claude-sonnet-5"), j("haiku", 0.9, 0.5), c, "haiku", ["downgrade"], false],
    ["downgrade blocked by low confidence", sub("claude-sonnet-5"), j("haiku", 0.69, 0.2), c, null, ["low_confidence"], false],
    ["exactly at the confidence floor is allowed", sub("claude-sonnet-5"), j("haiku", 0.7, 0.2), c, "haiku", ["downgrade"], false],
    ["haiku vetoed by reasoning_demand > 1.0", sub("claude-sonnet-5"), j("haiku", 0.95, 1.4), c, null, ["veto_reasoning_demand"], false],
    ["missing reasoning_demand vetoes a downgrade", sub("claude-sonnet-5"), j("haiku", 0.95), c, null, ["veto_reasoning_demand"], false],
    ["opus -> sonnet allowed at demand 2.5", sub("claude-opus-5"), j("sonnet", 0.8, 2.5), c, "sonnet", ["downgrade"], false],
    ["opus -> sonnet vetoed above 2.5", sub("claude-opus-5"), j("sonnet", 0.8, 2.6), c, null, ["veto_reasoning_demand"], false],
    ["same tier: nothing to do", sub("claude-sonnet-5"), j("sonnet", 0.99, 2), c, null, ["same_tier"], false],
    ["upgrade disabled by default, logged as would_upgrade", sub("claude-haiku-4-5-20251001"), j("opus", 0.99, 4), c, null, ["upgrade_disabled"], true],
    ["upgrade on", sub("claude-haiku-4-5-20251001"), j("opus", 0.5, 4), cfg({ REFLEX_UPGRADES: "on" }), "opus", ["upgrade"], true],
    ["upgrade confident needs confidence", sub("claude-haiku-4-5-20251001"), j("opus", 0.5, 4), cfg({ REFLEX_UPGRADES: "confident" }), null, ["upgrade_low_confidence"], true],
    ["clamp steps UP to the next enabled tier", sub("claude-opus-5"), j("haiku", 0.9, 0.2), cfg({ REFLEX_TIERS: "sonnet,opus" }), "sonnet", ["downgrade", "clamped_up"], false],
    ["no enabled tier between chosen and requested: no change (never steps down)", sub("claude-sonnet-5"), j("haiku", 0.9, 0.2), cfg({ REFLEX_TIERS: "opus" }), null, ["no_enabled_tier"], false],
    ["unknown requested model: never routed", sub("some-other-model"), j("haiku", 0.9, 0.2), c, null, ["requested_tier_unknown"], false],
    ["main chat with REFLEX_MAIN_CHAT=never", { kind: "main", requestedModel: "claude-sonnet-5" }, j("haiku", 0.9, 0.2), cfg({ REFLEX_MAIN_CHAT: "never" }), null, ["main_chat_disabled"], false],
    ["main chat (guarded): would-route is recorded, guard not yet evaluated", { kind: "main", requestedModel: "claude-sonnet-5" }, j("haiku", 0.9, 0.2), c, "haiku", ["guard_not_evaluated", "downgrade"], false],
    ["fable as an upgrade target is not enabled unless allowed", sub("claude-opus-5"), j("fable", 0.99, 4), cfg({ REFLEX_UPGRADES: "on" }), null, ["no_enabled_tier"], true],
    ["fable allowed", sub("claude-opus-5"), j("fable", 0.99, 4), cfg({ REFLEX_UPGRADES: "on", REFLEX_ALLOW_FABLE: "1" }), "fable", ["upgrade"], true],
  ];
  for (const [name, input, judgement, config, target, reasons, wouldUpgrade] of cases) {
    it(name, () => {
      const p = plan(input, judgement, config);
      assert.equal(p.target?.tier ?? null, target);
      assert.deepEqual(p.reasons, reasons);
      assert.equal(p.wouldUpgrade, wouldUpgrade);
    });
  }
});

describe("config for policy", () => {
  it("tier list is canonical, fable needs the explicit switch, unknown tiers are errors", () => {
    assert.deepEqual(cfg({ REFLEX_TIERS: "opus, haiku" }).tiers, ["haiku", "opus"]);
    const r = loadConfig({ REFLEX_TIERS: "fable,sonnet" });
    assert.ok(r.ok);
    assert.deepEqual(r.config.tiers, ["sonnet"]);
    assert.equal(r.warnings.length, 1);
    assert.equal(loadConfig({ REFLEX_TIERS: "gpt" }).ok, false);
  });

  it("model ids: REFLEX_MODEL_<TIER> > ANTHROPIC_DEFAULT_<TIER>_MODEL > built-in", () => {
    const c = cfg({ REFLEX_MODEL_HAIKU: "h1", ANTHROPIC_DEFAULT_HAIKU_MODEL: "h2", ANTHROPIC_DEFAULT_OPUS_MODEL: "o2" });
    assert.equal(c.models.haiku, "h1");
    assert.equal(c.models.opus, "o2");
    assert.equal(c.models.sonnet, "claude-sonnet-5");
  });

  it("numeric settings are bounded and named in errors", () => {
    const r = loadConfig({ REFLEX_BACKEND_TIMEOUT_MS: "0" });
    assert.ok(!r.ok);
    assert.match(r.errors.join(), /REFLEX_BACKEND_TIMEOUT_MS/);
    assert.equal(cfg({ REFLEX_SHAPE_CHECK_N: "3" }).shapeCheckN, 3);
    assert.equal(cfg({ REFLEX_LOG_PROMPTS: "0" }).logPrompts, false);
    assert.equal(cfg({}).logPrompts, true);
  });
});
