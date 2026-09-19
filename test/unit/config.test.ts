import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import { DEFAULT_UPSTREAM, defaultHome, isReflexEnvName, loadConfig, SETTING_NAMES, type Config } from "../../src/config.js";

const load = (env: NodeJS.ProcessEnv): { config: Config; warnings: readonly string[] } => {
  const r = loadConfig(env, "/home/u");
  assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
  return r;
};
const errors = (env: NodeJS.ProcessEnv): readonly string[] => {
  const r = loadConfig(env, "/home/u");
  assert.ok(!r.ok);
  return r.errors;
};

describe("loadConfig", () => {
  it("has safe defaults: shadow mode, jev backend, api.anthropic.com, state under ~/.reflex", () => {
    const { config, warnings } = load({});
    assert.equal(config.mode, "shadow");
    assert.equal(config.backend, "jev");
    assert.equal(config.upstreamUrl, DEFAULT_UPSTREAM);
    assert.equal(config.home, "/home/u/.reflex");
    assert.equal(config.typesafeApiKey, undefined);
    assert.equal(config.ignoreVersionCheck, false);
    assert.deepEqual(warnings, []);
  });

  it("parses mode and backend case-insensitively", () => {
    assert.equal(load({ REFLEX_MODE: "ROUTE" }).config.mode, "route");
    assert.equal(load({ REFLEX_MODE: " off " }).config.mode, "off");
    assert.equal(load({ REFLEX_BACKEND: "Local" }).config.backend, "local");
  });

  it("rejects unknown mode/backend values with the offending name in the message", () => {
    assert.match(errors({ REFLEX_MODE: "turbo" }).join(), /REFLEX_MODE/);
    assert.match(errors({ REFLEX_BACKEND: "gpt" }).join(), /REFLEX_BACKEND/);
    assert.equal(errors({ REFLEX_MODE: "x", REFLEX_BACKEND: "y" }).length, 2);
  });

  it("treats an empty value as unset", () => {
    assert.equal(load({ REFLEX_MODE: "" }).config.mode, "shadow");
  });

  it("upstream precedence: REFLEX_UPSTREAM_URL, then the user's ANTHROPIC_BASE_URL, then the default", () => {
    assert.equal(load({ REFLEX_UPSTREAM_URL: "http://a.test", ANTHROPIC_BASE_URL: "http://b.test" }).config.upstreamUrl, "http://a.test");
    assert.equal(load({ ANTHROPIC_BASE_URL: "https://gw.example.com" }).config.upstreamUrl, "https://gw.example.com");
  });

  it("keeps a gateway path prefix but drops trailing slashes", () => {
    assert.equal(load({ ANTHROPIC_BASE_URL: "https://gw.example.com/anthropic/" }).config.upstreamUrl, "https://gw.example.com/anthropic");
  });

  it("rejects non-http(s) and malformed upstream URLs, naming the variable", () => {
    assert.match(errors({ REFLEX_UPSTREAM_URL: "ftp://x" }).join(), /REFLEX_UPSTREAM_URL/);
    assert.match(errors({ ANTHROPIC_BASE_URL: "not a url" }).join(), /ANTHROPIC_BASE_URL/);
  });

  it("accepts a well-formed TypeSafe key and trims it", () => {
    assert.equal(load({ TYPESAFE_API_KEY: "  apikey_abc123  " }).config.typesafeApiKey, "apikey_abc123");
  });

  it("ignores a key without the apikey_ prefix, warns, and never echoes the value", () => {
    const { config, warnings } = load({ TYPESAFE_API_KEY: "sk-ant-secret-value" });
    assert.equal(config.typesafeApiKey, undefined);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings.join(), /sk-ant-secret-value/);
  });

  it("reads REFLEX_HOME, REFLEX_CLAUDE_BIN and the version-check switch", () => {
    const { config } = load({ REFLEX_HOME: "/data/rf", REFLEX_CLAUDE_BIN: "/opt/claude", REFLEX_IGNORE_VERSION_CHECK: "1" });
    assert.equal(config.home, "/data/rf");
    assert.equal(config.claudeBin, "/opt/claude");
    assert.equal(config.ignoreVersionCheck, true);
  });

  it("only a truthy word enables REFLEX_IGNORE_VERSION_CHECK", () => {
    for (const v of ["1", "true", "YES", "on"]) assert.equal(load({ REFLEX_IGNORE_VERSION_CHECK: v }).config.ignoreVersionCheck, true, v);
    for (const v of ["0", "false", "", "no", "maybe"]) assert.equal(load({ REFLEX_IGNORE_VERSION_CHECK: v }).config.ignoreVersionCheck, false, v);
  });
});

describe("isReflexEnvName", () => {
  it("matches reflex settings and every TypeSafe credential, nothing else", () => {
    for (const n of ["REFLEX_MODE", "REFLEX_ANYTHING", "TYPESAFE_API_KEY", "TYPESAFE_BASE_URL"]) assert.equal(isReflexEnvName(n), true, n);
    for (const n of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_X", "PATH", "reflex_mode"]) assert.equal(isReflexEnvName(n), false, n);
  });
});

describe("SETTING_NAMES", () => {
  const source = fs.readFileSync("src/config.ts", "utf8");
  it("lists every variable loadConfig reads, and nothing it does not", () => {
    const read = new Set<string>();
    for (const m of source.matchAll(/env\["([A-Z_]+)"\]/g)) read.add(m[1]!);
    for (const t of ["HAIKU", "SONNET", "OPUS", "FABLE"]) {
      read.add(`REFLEX_MODEL_${t}`);
      read.add(`ANTHROPIC_DEFAULT_${t}_MODEL`);
    }
    assert.deepEqual([...SETTING_NAMES].sort(), [...read].sort());
  });
  it("defaultHome is REFLEX_HOME, else ~/.reflex", () => {
    assert.equal(defaultHome({}, "/h"), "/h/.reflex");
    assert.equal(defaultHome({ REFLEX_HOME: " /x " }, "/h"), "/x");
  });
});
