import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Config, Mode } from "../../src/config.js";
import { resolveEffectiveMode } from "../../src/effective-mode.js";
import type { VersionVerdict } from "../../src/launcher/version.js";

const cfg = (over: Partial<Config> = {}): Config => ({
  mode: "route", backend: "jev", upstreamUrl: "https://api.anthropic.com", claudeBin: undefined, home: "/h", ignoreVersionCheck: false, typesafeApiKey: "apikey_x", ...over,
});
const verdict = (level: VersionVerdict["level"]): VersionVerdict => ({ level, reason: level === "degrade" ? "major_mismatch" : "exact_match", running: "3.0.0", tested: ["2.1.277"] });

describe("resolveEffectiveMode", () => {
  it("off stays off regardless of anything else", () => {
    assert.deepEqual(resolveEffectiveMode(cfg({ mode: "off", typesafeApiKey: undefined }), verdict("degrade")), { mode: "off", degradedReason: null });
  });

  it("without a backend key there is nothing to decide with: passthrough", () => {
    for (const mode of ["route", "shadow"] as Mode[]) {
      assert.deepEqual(resolveEffectiveMode(cfg({ mode, typesafeApiKey: undefined }), null), { mode: "passthrough", degradedReason: "no_backend_key" });
    }
  });

  it("the local backend is a stub for now: passthrough", () => {
    assert.equal(resolveEffectiveMode(cfg({ backend: "local", typesafeApiKey: undefined }), null).degradedReason, "backend_local_not_implemented");
  });

  it("a major-version mismatch turns route into shadow, and says why", () => {
    assert.deepEqual(resolveEffectiveMode(cfg(), verdict("degrade")), { mode: "shadow", degradedReason: "claude_version:major_mismatch" });
  });

  it("a major-version mismatch does not touch shadow", () => {
    assert.deepEqual(resolveEffectiveMode(cfg({ mode: "shadow" }), verdict("degrade")), { mode: "shadow", degradedReason: null });
  });

  it("warn and ok verdicts never change the mode (the version is only a hint)", () => {
    assert.equal(resolveEffectiveMode(cfg(), verdict("warn")).mode, "route");
    assert.equal(resolveEffectiveMode(cfg(), verdict("ok")).mode, "route");
    assert.equal(resolveEffectiveMode(cfg(), null).mode, "route");
  });

  it("REFLEX_IGNORE_VERSION_CHECK suppresses the degrade", () => {
    assert.deepEqual(resolveEffectiveMode(cfg({ ignoreVersionCheck: true }), verdict("degrade")), { mode: "route", degradedReason: null });
  });
});
