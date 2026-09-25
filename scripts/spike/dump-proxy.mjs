#!/usr/bin/env node
// Spike (not product code): a loopback pass-through to https://api.anthropic.com that writes each POST /v1/messages
// request body (never headers) to DIR/NNN.json. Put it BEHIND reflex to see exactly what reflex sent (Claude Code's
// tool search stays on, unlike scripts/spike/capture.mjs, which sits in front of claude):
//   node scripts/spike/dump-proxy.mjs _dumps/<name> [port=47200]
//   REFLEX_UPSTREAM_URL=http://127.0.0.1:47200 reflex ...
// Bodies hold prompts: keep DIR under _dumps/ (gitignored).
import http from "node:http"; import https from "node:https"; import fs from "node:fs";
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true, mode: 0o700 }); let n = 0;
const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length"]);
http.createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (req.method === "POST" && req.url.startsWith("/v1/messages")) fs.writeFileSync(`${out}/${String(++n).padStart(3, "0")}.json`, body, { mode: 0o600 });
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k)));
    const up = https.request({ host: "api.anthropic.com", path: req.url, method: req.method, headers: { ...headers, "content-length": body.length } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); }); up.end(body);
  });
}).listen(Number(process.argv[3] ?? 47200), "127.0.0.1", () => console.log("up"));
