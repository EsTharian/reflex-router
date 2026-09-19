// `reflex share` must be an allow-list, not a redactor: a field reaches the shared file only because it is named in
// src/report/share.ts. These tests are the guarantee the command's own output promises to the user.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { NEVER_SHARED, buildShare, shareCommand, shareRecord } from "../../src/report/share.js";
import { dec, outcome, toJsonl, update } from "../support/report-fixtures.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "reflex-share-"));

/** A decision record carrying every kind of text a real one can carry. */
const loaded = (): Record<string, unknown> => ({
  ...(dec({ id: "d1", t: 0, turn: "new", sent: "haiku", promptEncoding: "string", ab: "routed" }) as Record<string, unknown>),
  prompt_preview: "read src/pricing.ts and explain the cache maths",
  error: "backend:network:503",
  side_fingerprint: { v: 3, head: "SECRET PREAMBLE" },
  forwarded: { requested_model: "claude-opus-5", model: "claude-haiku-4-5-20251001", rewritten: true, fields: ["model"], fallback: false, fallback_status: null, fallback_error: "upstream said: /Users/someone/secret.ts" },
  sent: { keys: ["task", "context"], chars: 812 },
});

describe("reflex share: the allow-list", () => {
  it("drops every field that could carry text the user or the model wrote", () => {
    const shared = shareRecord(loaded())!;
    const json = JSON.stringify(shared);
    for (const f of NEVER_SHARED) assert.ok(!(f in shared), `${f} must not be a key`);
    assert.doesNotMatch(json, /pricing\.ts|explain the cache|SECRET PREAMBLE|secret\.ts|backend:network/);
  });

  it("keeps the structural fields calibration actually needs", () => {
    const shared = shareRecord(loaded())! as Record<string, unknown>;
    for (const f of ["id", "at", "session", "kind", "turn", "requested", "decision", "plan", "forwarded", "usage", "prompt_encoding", "ab"]) {
      assert.ok(f in shared, `${f} should be shared`);
    }
    assert.equal((shared["forwarded"] as Record<string, unknown>)["rewritten"], true);
    assert.equal(shared["prompt_encoding"], "string");
    assert.equal(shared["ab"], "routed");
    // fallback_error rides inside `forwarded`; it must be dropped there too, not only at the top level.
    assert.ok(!("fallback_error" in (shared["forwarded"] as Record<string, unknown>)));
  });

  it("shares outcome, outcome_update and delegate_hint records, and drops an unknown type", () => {
    assert.ok(shareRecord(outcome({ id: "o1", t: 1, decision: "d1", edits: 2, score: 1 })));
    assert.ok(shareRecord(update("u1", 2, "d1")));
    assert.ok(shareRecord({ v: 1, record: "delegate_hint", id: "h1", at: "2026-09-19T00:00:00.000Z", session: "aaaa", version: "delegate-1" }));
    assert.equal(shareRecord({ v: 1, record: "something_new", id: "x", secret: "text" }), null);
  });

  it("an outcome record keeps rule ids and counts and nothing else", () => {
    const o = shareRecord(outcome({ id: "o1", t: 1, decision: "d1", edits: 2, score: 1, testFailure: true }))!;
    assert.ok("counts" in o && "signals" in o && "params" in o);
    assert.doesNotMatch(JSON.stringify(o), /\//, "no path-like text in an outcome record");
  });

  it("a field added to the record in future is NOT shared until it is named", () => {
    const shared = shareRecord({ ...loaded(), brand_new_field: "whatever this turns out to be" })!;
    assert.ok(!("brand_new_field" in shared), "the allow-list must fail closed");
  });
});

describe("reflex share: the command", () => {
  const run = (args: readonly string[], home: string): { code: number; out: string; err: string } => {
    let out = "";
    let err = "";
    const code = shareCommand(args, { env: { REFLEX_HOME: home }, stdout: (t) => (out += t), stderr: (t) => (err += t) });
    return { code, out, err };
  };

  it("writes the file, prints exactly what is in it, and says it sent nothing", () => {
    const home = tmp();
    const log = path.join(home, "decisions.jsonl");
    fs.writeFileSync(log, toJsonl([dec({ id: "d1", t: 0, turn: "new" }), outcome({ id: "o1", t: 1, decision: "d1", edits: 1 })]));
    const target = path.join(home, "out.jsonl");
    const { code, out } = run(["--out", target, log], home);
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(target, "utf8").trim().split("\n").length, 2);
    assert.match(out, /wrote 2 records: decision 1, outcome 1/);
    assert.match(out, /reflex sent nothing/);
    assert.match(out, /no code path that uploads this/);
    assert.match(out, /What it cannot contain/);
  });

  it("writes the file 0600 and refuses unknown options", () => {
    const home = tmp();
    const log = path.join(home, "decisions.jsonl");
    fs.writeFileSync(log, toJsonl([dec({ id: "d1", t: 0, turn: "new" })]));
    const target = path.join(home, "out.jsonl");
    assert.equal(run(["--out", target, log], home).code, 0);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(run(["--nope"], home).code, 2);
    assert.equal(run(["--since", "banana"], home).code, 2);
  });

  it("tolerates junk lines instead of failing, and says how many it skipped", () => {
    const home = tmp();
    const log = path.join(home, "decisions.jsonl");
    fs.writeFileSync(log, `not json\n${toJsonl([dec({ id: "d1", t: 0, turn: "new" })])}`);
    const { code, out } = run(["--out", path.join(home, "o.jsonl"), log], home);
    assert.equal(code, 0);
    assert.match(out, /skipped 1 line/);
  });

  it("--since keeps only records at or after the cutoff", () => {
    const old = buildShare([toJsonl([dec({ id: "old", t: 0, turn: "new" })])], Date.now());
    assert.equal(old.lines.length, 0);
    const kept = buildShare([toJsonl([dec({ id: "new", t: 0, turn: "new" })])], 0);
    assert.equal(kept.lines.length, 1);
  });
});
