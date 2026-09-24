#!/usr/bin/env node
// Spike (not product code): a loopback stand-in for the Anthropic Messages API, for running the REAL `claude` (or a
// reflex in front of it) without spending tokens. Every POST /v1/messages gets a complete SSE reply ("ok", with
// usage); HEAD/GET answer 200 with an empty JSON body. Each request is written to --out as NNN.json: method, url,
// headers (credential headers omitted, never written) and the parsed body. Raw bodies hold prompts: keep --out
// under _dumps/ (gitignored).
//
//   node scripts/spike/fake-anthropic.mjs --out _dumps/<name> [--port 0]
//   ANTHROPIC_BASE_URL=http://127.0.0.1:<port> claude -p "..."          (or REFLEX_UPSTREAM_URL=... reflex -p "...")
//
// Prints the port on stdout as `port <n>`; ends on SIGINT/SIGTERM.
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const out = flag("--out", join("_dumps", "fake-anthropic-" + Date.now()));
mkdirSync(out, { recursive: true, mode: 0o700 });
const SECRET = new Set(["authorization", "x-api-key", "cookie", "proxy-authorization"]);
let seq = 0;

const sse = (model) =>
  [
    ["message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = { unparsed_bytes: raw.length }; }
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, SECRET.has(k) ? "[omitted]" : v]));
    writeFileSync(join(out, `${String(++seq).padStart(3, "0")}.json`), JSON.stringify({ method: req.method, url: req.url, headers, body }), { mode: 0o600 });
    if (req.method === "POST" && req.url?.split("?")[0] === "/v1/messages") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.end(sse(body?.model ?? "claude-opus-5-5"));
    } else res.writeHead(200, { "content-type": "application/json" }).end(req.method === "HEAD" ? undefined : "{}");
  });
});
server.listen(Number(flag("--port", "0")), "127.0.0.1", () => console.log(`port ${server.address().port}`));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => server.close(() => process.exit(0)));
