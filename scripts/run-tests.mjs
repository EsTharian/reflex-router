#!/usr/bin/env node
// Runs the test suite with the node test runner. Works on Node >= 20 (explicit file list, no globs).
//   node scripts/run-tests.mjs            offline tests (network guard active)
//   node scripts/run-tests.mjs --live     tests under test/live (need TYPESAFE_API_KEY; they skip themselves without it)
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const live = args.includes("--live");
const filters = args.filter((a) => !a.startsWith("--"));

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const all = walk("test").filter((f) => f.endsWith(".test.ts") && !f.startsWith(join("test", "fixtures")));
let files = all.filter((f) => f.startsWith(join("test", "live") + "/") === live);
if (filters.length) files = files.filter((f) => filters.some((x) => f.includes(x)));
if (files.length === 0) {
  console.log(live ? "no live tests selected" : "no tests selected");
  process.exit(live ? 0 : 1);
}
const nodeArgs = ["--import", "tsx"];
if (!live) nodeArgs.push("--import", "./test/support/no-network.ts"); // offline suite: only loopback connections allowed
nodeArgs.push("--test", ...files);
const r = spawnSync(process.execPath, nodeArgs, { stdio: "inherit" });
process.exit(r.status ?? 1);
