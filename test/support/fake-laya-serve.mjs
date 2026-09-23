#!/usr/bin/env node
// A stand-in for `laya-serve` used by launcher tests: binds LAYA_HOST:LAYA_PORT, answers /health and /v1/systemone.
//   FAKE_LAYA_REPORT   file a JSON report is written to on start and after each request
//   FAKE_LAYA_LOAD_MS  how long /health reports loaded:false (default 0)
//   FAKE_LAYA_NEVER_READY=1   /health never reports loaded
import http from "node:http";
import { writeFileSync } from "node:fs";

const env = process.env;
const started = Date.now();
const report = {
  pid: process.pid,
  env: Object.fromEntries(["LAYA_HOST", "LAYA_PORT", "LAYA_PRELOAD", "LAYA_MODELS", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"].map((k) => [k, env[k] ?? null])),
  hasApiKey: typeof env.LAYA_API_KEY === "string" && env.LAYA_API_KEY.length >= 32,
  leaked: Object.keys(env).filter((k) => k.startsWith("REFLEX_") || k.startsWith("TYPESAFE_") || k.startsWith("ANTHROPIC_")),
  health: [],
};
const save = () => { if (env.FAKE_LAYA_REPORT) writeFileSync(env.FAKE_LAYA_REPORT, JSON.stringify(report)); };

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    const loaded = !env.FAKE_LAYA_NEVER_READY && Date.now() - started >= Number(env.FAKE_LAYA_LOAD_MS ?? 0);
    report.health.push({ auth: req.headers.authorization === `Bearer ${env.LAYA_API_KEY}`, loaded });
    save();
    // As the real laya-serve 0.3.x answers: the list of loaded checkpoints, not a boolean.
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", loaded: loaded ? (env.LAYA_MODELS ?? "").split(",") : [], device: "auto" }));
    return;
  }
  res.writeHead(404).end();
});
server.listen(Number(env.LAYA_PORT), env.LAYA_HOST ?? "0.0.0.0", save);
process.on("SIGTERM", () => process.exit(0));
