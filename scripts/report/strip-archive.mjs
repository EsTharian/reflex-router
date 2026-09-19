#!/usr/bin/env node
// Copies decision records from archived decisions.jsonl files keeping only the structural fields the workflow profile
// reads (an allow-list): no prompt_preview, no fallback_error text, no backend answers. Ids and conversation keys are
// already hashes or random UUIDs. Used to build test/fixtures/report/archives/ from ~/.reflex/archive/*.jsonl.
//   node scripts/report/strip-archive.mjs <in.jsonl> <out.jsonl>
import fs from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: strip-archive.mjs <in.jsonl> <out.jsonl>");
  process.exit(2);
}
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const pick = (o, keys) => (isObj(o) ? Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])) : null);

const out = [];
let dropped = 0;
for (const line of fs.readFileSync(input, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const o = JSON.parse(line);
  if ((o.record ?? "decision") !== "decision") {
    dropped++;
    continue;
  }
  const tier = o.plan?.target?.tier;
  out.push({
    v: o.v,
    record: "decision",
    ...pick(o, ["id", "at", "session", "conv", "kind", "turn", "side_kind", "mode_requested", "mode_effective", "degraded_reason", "claude_version", "delegate_hint", "cache_ttl_beta", "side_marker"]),
    requested: pick(o.requested, ["model", "tier"]),
    // Only whether the backend answered, and its applied pick.
    decision: isObj(o.decision) ? { picks: { tier: { value: o.decision.picks?.tier?.value ?? null } } } : null,
    plan: isObj(o.plan) ? { target: typeof tier === "string" ? { tier } : null, reasons: Array.isArray(o.plan.reasons) ? o.plan.reasons : [] } : null,
    forwarded: pick(o.forwarded, ["requested_model", "model", "rewritten", "fallback"]),
    usage: pick(o.usage, ["input", "output", "cache_read", "cache_create"]),
  });
}
fs.writeFileSync(output, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`${output}: ${out.length} decision records (${dropped} non-decision records dropped)`);
