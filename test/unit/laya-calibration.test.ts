import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { JevBackend, validateAnswer } from "../../src/backend/jev.js";
import { LayaBackend } from "../../src/backend/laya.js";
import { CAL_TIERS, calibratedAnswers, FEATURE_QUESTIONS, FEATURE_VERSION, layaFeatures, type LayaCalibration } from "../../src/backend/laya-calibration.js";
import { LAYA_CALIBRATIONS } from "../../src/backend/laya-calibration.generated.js";
import { loadConfig } from "../../src/config.js";
import { buildQuestions, judge } from "../../src/policy.js";
import type { Answer, DecisionState } from "../../src/types.js";
import { calibrationOf, crossValidate, score, targetOf, type Sample } from "../../scripts/calibrate/lib.js";
import { startFakeJev, type FakeJev } from "../support/fake-jev.js";

const loaded = loadConfig({});
assert.ok(loaded.ok);
const cfg = loaded.config;
const questions = buildQuestions(cfg);
const state: DecisionState = { task: "rename foo", context: { requesting_tier: "opus", is_subagent: true } };
const D = 3 + 1 + Object.keys(FEATURE_QUESTIONS).length + 2 + 1;

const answers = (pOpus: number, fp = 0.5): Record<string, Answer> => ({
  tier: { type: "choice", choice: "opus", confidence: 0.2, probabilities: { haiku: (1 - pOpus) / 2, sonnet: (1 - pOpus) / 2, opus: pOpus } },
  reasoning_demand: { type: "score", score: 2, confidence: 0.2, probabilities: { "0": 0, "1": 0, "2": 1, "3": 0, "4": 0 } },
  ...Object.fromEntries(Object.keys(FEATURE_QUESTIONS).map((id) => [id, { type: "noul", p: fp }])),
});

/** Synthetic data where the teacher's tier is a clean function of one feature question (f_mechanical). */
const synthetic = (n: number): Sample[] =>
  Array.from({ length: n }, (_, i) => {
    const mech = (i * 37) % 100 / 100;
    const x = layaFeatures({ ...answers(0.5), f_mechanical: { type: "noul", p: 0.01 + 0.98 * mech } }, state)!;
    const t = mech > 0.66 ? { haiku: 0.95, sonnet: 0.05, opus: 0 } : mech > 0.33 ? { haiku: 0.02, sonnet: 0.93, opus: 0.05 } : { haiku: 0, sonnet: 0.05, opus: 0.95 };
    return { x, t: targetOf(t, 4 * (1 - mech))!, group: `g${i % 17}` };
  });

describe("Laya calibration head", () => {
  it("builds one feature per answer plus context and bias, and refuses incomplete answers", () => {
    const x = layaFeatures(answers(0.5), state);
    assert.equal(x?.length, D);
    assert.equal(x?.at(-1), 1, "bias last");
    const { f_design: _dropped, ...partial } = answers(0.5);
    assert.equal(layaFeatures(partial, state), null);
  });

  it("recovers a mapping the raw probabilities cannot show (cross-validated)", () => {
    const samples = synthetic(120);
    const oof = crossValidate(samples, 0.01);
    const argmax = (p: Readonly<Record<string, number>>): string => CAL_TIERS.reduce((a, t) => ((p[t] ?? 0) > (p[a] ?? 0) ? t : a));
    const hits = samples.filter((smp, i) => argmax(oof[i]!.p) === argmax(smp.t.p)).length;
    assert.ok(hits / samples.length > 0.9, `argmax agreement ${hits}/${samples.length}`);
    // Near a boundary a linear head spreads probability, and the mass rule then keeps the dearer tier: never cheaper.
    const s = score(samples.map((smp, i) => ({ ...oof[i]!, t: smp.t })), 0.1);
    assert.equal(s.under, 0, JSON.stringify(s));
  });

  it("produces answers the backend validator and the policy accept, with the shipped shape", () => {
    const cal = calibrationOf("cal-test", FEATURE_VERSION, synthetic(120), 0.01, { samples: 120 });
    const x = layaFeatures({ ...answers(0.5), f_mechanical: { type: "noul", p: 0.99 } }, state)!;
    const a = calibratedAnswers(cal, x);
    validateAnswer("tier", questions["tier"]!, { ...a.tier, probabilities: a.tier.type === "choice" ? a.tier.probabilities : {} });
    const j = judge({ answers: a, latencyMs: 1, backendModel: "m", tokensIn: null, connection: null }, cfg);
    assert.ok(j.ok);
    assert.equal(j.judgement.tier.value, "haiku", "a clearly mechanical task is routed down once calibrated");
    assert.deepEqual(Object.keys(a.tier.type === "choice" ? a.tier.probabilities : {}), [...CAL_TIERS]);
  });
});

describe("LayaBackend", () => {
  let laya: FakeJev;
  before(async () => {
    laya = await startFakeJev({ kind: "answer", tier: "opus", confidence: 0.4, reasoning: 2 });
  });
  after(() => laya.close());
  const cal: LayaCalibration = calibrationOf("cal-test", FEATURE_VERSION, synthetic(60), 0.01, {});
  const make = (c: LayaCalibration | undefined): LayaBackend => new LayaBackend(new JevBackend({ id: "laya", baseUrl: laya.url, model: "typed-decisions", deadlineMs: 2000 }), c);
  const signal = { signal: new AbortController().signal };

  it("with a calibration: asks the feature questions too, answers only the product's, names the calibration", async () => {
    const b = make(cal);
    const d = await b.decide(state, questions, signal);
    assert.deepEqual(Object.keys(laya.calls.at(-1)!.body.questions).sort(), [...Object.keys(questions), ...Object.keys(FEATURE_QUESTIONS)].sort());
    assert.deepEqual(Object.keys(d.answers).sort(), Object.keys(questions).sort());
    assert.equal(d.backendModel, "jev-test+cal-test");
    b.close();
  });

  it("without one, or for another feature version, or with Fable offered: Laya's own answers to the product's questions only", async () => {
    for (const [b, qs] of [
      [make(undefined), questions],
      [make({ ...cal, featureVersion: "lf-0" }), questions],
      [make(cal), buildQuestions({ ...cfg, allowFable: true })],
    ] as const) {
      const d = await b.decide(state, qs, signal);
      assert.deepEqual(Object.keys(laya.calls.at(-1)!.body.questions).sort(), Object.keys(qs).sort());
      assert.equal(d.backendModel, "jev-test");
      b.close();
    }
  });
});

describe("shipped calibrations (laya-calibration.generated.ts)", () => {
  for (const [model, cal] of Object.entries(LAYA_CALIBRATIONS)) {
    it(`${model}: fitted for this feature layout, and its answers pass the validator and the policy`, () => {
      assert.equal(cal.featureVersion, FEATURE_VERSION);
      assert.equal(cal.tierWeights.length, CAL_TIERS.length);
      for (const w of [...cal.tierWeights, cal.demandWeights]) assert.equal(w.length, D);
      for (const pOpus of [0.1, 0.5, 0.9]) {
        const a = calibratedAnswers(cal, layaFeatures(answers(pOpus, 0.3), state)!);
        assert.ok(a.tier.type === "choice");
        validateAnswer("tier", questions["tier"]!, a.tier);
        validateAnswer("reasoning_demand", questions["reasoning_demand"]!, a.reasoning_demand);
        assert.ok(judge({ answers: a, latencyMs: 1, backendModel: "m", tokensIn: null, connection: null }, cfg).ok);
      }
    });
  }
});
