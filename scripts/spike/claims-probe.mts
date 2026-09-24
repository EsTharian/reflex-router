// Spike (not product code): replays the claim scenarios of the 2026-09-25 verification (docs/observations.md) through
// the real front door + worker, a fake upstream and a fake Jev, and prints what went upstream. No network, no tokens.
//   node --import tsx scripts/spike/claims-probe.mts c2 c3 c4 c4off c5 c6 c9
// c2 explicit subagent model, c3 pinned subagent summary, c4/c4off effort marks on side calls (off = control),
// c5 effort above the client level, c6 concurrent decisions, c9 resends (rejected rewrite; worker killed mid-request).
import crypto from "node:crypto";
import { startStack } from "../../test/support/stack.ts";
import { startFakeJev } from "../../test/support/fake-jev.ts";
import { loadFixtures } from "../../test/support/fixtures.ts";
import { records, sseHandler } from "../../test/support/replay.ts";
import { request, waitFor } from "../../test/support/http.ts";
import { parseRequest } from "../../src/wire/claude-code.ts";

type Json = Record<string, any>;
const fx = loadFixtures();
const get = (name: string): { headers: Json; body: Json } => {
  const f = fx.find((x) => x.version === "2.1.280" && x.file === `print-agent.${name}.request.json`)!;
  return { headers: f.headers, body: JSON.parse(f.body.toString()) };
};
const mainNew = get("main-new-turn");
const mainCont = { headers: mainNew.headers, body: { ...get("main-continuation").body, messages: [...mainNew.body.messages, ...get("main-continuation").body.messages.slice(2)] } };
const subNew = get("subagent-new-turn");
const subCont = { headers: subNew.headers, body: { ...get("subagent-continuation").body, messages: [...subNew.body.messages, ...get("subagent-continuation").body.messages.slice(2)] } };

/** Same request in session `sid` (and agent `agent`, for subagents); header and metadata change together. */
function at(req: { headers: Json; body: Json }, sid: string, agent?: string, mut?: (b: Json) => void): { headers: Json; body: Buffer } {
  const b = structuredClone(req.body);
  b.metadata.user_id = JSON.stringify({ ...JSON.parse(b.metadata.user_id), session_id: sid });
  mut?.(b);
  const { host: _h, "content-length": _c, ...h } = req.headers;
  return { headers: { ...h, "x-claude-code-session-id": sid, ...(agent ? { "x-claude-code-agent-id": agent } : {}) }, body: Buffer.from(JSON.stringify(b)) };
}
const withMsgs = (extra: Json[]) => (b: Json): void => { b.messages = [...b.messages, ...extra]; };

async function send(stack: any, r: { headers: Json; body: Buffer }): Promise<{ sent: Json; rec: any }> {
  const before = records(stack).length;
  const n = stack.upstream.seen.length;
  await request(`${stack.url}/v1/messages?beta=true`, { method: "POST", headers: r.headers, body: r.body });
  const all = await waitFor(() => (records(stack).length > before ? records(stack) : null));
  return { sent: JSON.parse(stack.upstream.seen[n].body.toString()), rec: all[before] };
}
const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "cache_control").map(([k, x]) => [k, canon(x)])) : v;
const key = (m: Json): string => JSON.stringify(canon(typeof m.content === "string" ? { ...m, content: [{ type: "text", text: m.content }] } : m));
function firstDiff(a: Json[], b: Json[]): string {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (key(a[i]) !== key(b[i])) return `index ${i} (prev ${a[i].role}${a[i].output_config ? ":" + a[i].output_config.effort : ""} vs side ${b[i].role}${b[i].output_config ? ":" + b[i].output_config.effort : ""})`;
  return `none in the shared ${n} messages`;
}
const shape = (ms: Json[]): string => ms.map((m) => m.role[0] + (m.output_config ? `:${m.output_config.effort}` : "")).join(" ");

const which = new Set(process.argv.slice(2));
const jev = await startFakeJev({ kind: "answer", tier: "opus", reasoning: 1 });

if (which.has("c2")) {
  for (const upgrades of ["off", "on"] as const) {
    const stack = await startStack({ effectiveMode: "route", config: { mode: "route", jevBaseUrl: jev.url, upgrades } });
    stack.upstream.setHandler(sseHandler);
    const task = parseRequest(subNew.headers as never, Buffer.from(JSON.stringify(subNew.body))).ok ? (parseRequest(subNew.headers as never, Buffer.from(JSON.stringify(subNew.body))) as any).view.task : null;
    const cases = [
      { name: "(a) no model, inherits opus", model: undefined, requested: "claude-opus-5-5", jev: "sonnet" },
      { name: "(b) model: sonnet", model: "sonnet", requested: "claude-sonnet-5", jev: "opus" },
      { name: "(c) model: opus", model: "opus", requested: "claude-opus-5-5", jev: "sonnet" },
    ];
    for (const [i, c] of cases.entries()) {
      const sid = `c2-${upgrades}-${i}`;
      // The main chat's Agent call: PreToolUse (matcher Agent|Task) arrives before the subagent's first request.
      const hook = await request(`${stack.url}/__reflex/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sid, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: "d", prompt: task, subagent_type: "general-purpose", ...(c.model ? { model: c.model } : {}) } }) });
      jev.set({ kind: "answer", tier: c.jev, reasoning: 1 });
      const r = await send(stack, at(subNew, sid, "AGENT-C2", (b) => { b.model = c.requested; }));
      console.log(`C2 upgrades=${upgrades} ${c.name}: requested ${c.requested}, jev ${c.jev} -> upstream model ${r.sent.model}; hook status ${hook.status}; plan.reasons ${JSON.stringify(r.rec.plan?.reasons)}`);
    }
    await stack.close();
  }
}

if (which.has("c3")) {
  const stack = await startStack({ effectiveMode: "route", config: { mode: "route", jevBaseUrl: jev.url } });
  stack.upstream.setHandler(sseHandler);
  jev.set({ kind: "answer", tier: "sonnet", reasoning: 1 });
  const summary = [{ role: "assistant", content: [{ type: "text", text: "working" }] }, { role: "user", content: [{ type: "text", text: "Describe your most recent action in 3-5 words." }] }];
  for (const [label, r] of [["new", at(subNew, "c3", "A3")], ["continuation", at(subCont, "c3", "A3")], ["agent_summary", at(subCont, "c3", "A3", withMsgs(summary))], ["continuation", at(subCont, "c3", "A3")]] as const) {
    const o = await send(stack, r);
    console.log(`C3 ${label.padEnd(13)} turn=${o.rec.turn} side_kind=${o.rec.side_kind} -> upstream model ${o.sent.model}`);
  }
  await stack.close();
}

for (const on of [false, true].filter((x) => which.has(x ? "c4" : "c4off"))) {
  const stack = await startStack({ effectiveMode: "route", config: { mode: "route", jevBaseUrl: jev.url, effort: on, effortMidturn: on } });
  stack.upstream.setHandler(sseHandler);
  jev.set({ kind: "answer", tier: "opus", reasoning: 0 }); // same tier, effort low (client: medium)
  const a1 = { role: "assistant", content: [{ type: "text", text: "done" }] };
  const sides: [string, Json[]][] = [
    ["suggestion", [a1, { role: "user", content: [{ type: "text", text: "[SUGGESTION MODE: Suggest what the user might naturally type next.]" }] }]],
    ["cross_session", [a1, { role: "user", content: [{ type: "text", text: "Another Claude session sent a message:\nhello" }] }]],
    ["task_notification", [a1, { role: "user", content: [{ type: "text", text: "[SYSTEM NOTIFICATION - NOT USER INPUT] task done" }] }]],
    ["session_recap", [a1, { role: "user", content: "The user stepped away and is coming back. Recap in under 40 words." }]],
    ["tool_result_text", [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "Bash", input: { command: "ls" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "a\nb" }, { type: "text", text: "Harness note: output truncated." }] }]],
  ];
  const n0 = await send(stack, at(mainNew, "c4"));
  const c0 = await send(stack, at(mainCont, "c4"));
  console.log(`C4 effort=${on} main new: fields ${JSON.stringify(n0.rec.forwarded.fields)} | continuation: fields ${JSON.stringify(c0.rec.forwarded.fields)} shape ${shape(c0.sent.messages)}`);
  for (const [k, extra] of sides) {
    const s = await send(stack, at(mainCont, "c4", undefined, withMsgs(extra)));
    console.log(`C4 effort=${on} main ${k.padEnd(17)} turn=${s.rec.turn}/${s.rec.side_kind} fields ${JSON.stringify(s.rec.forwarded.fields)} first divergence vs continuation: ${firstDiff(c0.sent.messages, s.sent.messages)}`);
  }
  const sn = await send(stack, at(subNew, "c4", "A4"));
  const sc = await send(stack, at(subCont, "c4", "A4"));
  const ss = await send(stack, at(subCont, "c4", "A4", withMsgs([a1, { role: "user", content: [{ type: "text", text: "Describe your most recent action in 3-5 words." }] }])));
  console.log(`C4 effort=${on} subagent new fields ${JSON.stringify(sn.rec.forwarded.fields)} | cont fields ${JSON.stringify(sc.rec.forwarded.fields)} | agent_summary turn=${ss.rec.turn}/${ss.rec.side_kind} fields ${JSON.stringify(ss.rec.forwarded.fields)} first divergence: ${firstDiff(sc.sent.messages, ss.sent.messages)}`);
  await stack.close();
}

if (which.has("c5")) {
  for (const effortUp of [false, true]) {
    const stack = await startStack({ effectiveMode: "route", config: { mode: "route", jevBaseUrl: jev.url, effort: true, effortMidturn: true, effortUp } });
    stack.upstream.setHandler(sseHandler);
    jev.set({ kind: "answer", tier: "opus", reasoning: 3.9 });
    const r = await send(stack, at(mainNew, `c5-${effortUp}`));
    console.log(`C5 effortUp=${effortUp}: client output_config.effort ${mainNew.body.output_config.effort} -> upstream top ${r.sent.output_config?.effort}, message ${r.sent.messages.at(-1).output_config?.effort}; record effort ${JSON.stringify(r.rec.effort)}`);
    await stack.close();
  }
}

if (which.has("c6")) {
  for (const delay of [400, 800]) {
    for (const n of [1, 4, 6, 8]) {
      const stack = await startStack({ effectiveMode: "route", config: { mode: "route", jevBaseUrl: jev.url } });
      stack.upstream.setHandler(sseHandler);
      jev.set({ kind: "answer", tier: "sonnet", reasoning: 1, delayMs: delay });
      const sid = `c6-${delay}-${n}-${crypto.randomUUID()}`;
      const before = records(stack).length;
      await Promise.all(Array.from({ length: n }, (_, i) => request(`${stack.url}/v1/messages?beta=true`, { method: "POST", ...(() => { const r = at(subNew, sid, `A6-${i}`); return { headers: r.headers, body: r.body }; })() })));
      const recs = (await waitFor(() => (records(stack).length >= before + n ? records(stack) : null))).slice(before);
      const waits = recs.map((r: any) => r.timing.decision_wait_ms).sort((a: number, b: number) => a - b);
      const late = recs.filter((r: any) => r.error === "decision_late" || String(r.error).includes("timeout")).length;
      console.log(`C6 jev delay ${delay} ms, ${n} concurrent: decision_wait_ms ${JSON.stringify(waits)}, late/timeout ${late}/${n}, errors ${JSON.stringify([...new Set(recs.map((r: any) => r.error))])}`);
      await stack.close();
    }
  }
}

if (which.has("c9")) {
  const stack = await startStack({ effectiveMode: "route", config: { mode: "route", jevBaseUrl: jev.url } });
  jev.set({ kind: "answer", tier: "sonnet", reasoning: 1 });
  stack.upstream.setHandler((req, res, body) => {
    const m = JSON.parse(body.toString()).model;
    if (m !== "claude-opus-5-5") { res.writeHead(400, { "content-type": "application/json" }); res.end('{"type":"error","error":{"type":"invalid_request_error","message":"x"}}'); return; }
    sseHandler(req, res, body);
  });
  let n = stack.upstream.seen.length;
  const r1 = await request(`${stack.url}/v1/messages?beta=true`, { method: "POST", ...at(subNew, "c9a", "A9") });
  console.log(`C9(1) rewrite rejected with 400: client got ${r1.status}; upstream saw ${stack.upstream.seen.length - n} requests: ${stack.upstream.seen.slice(n).map((s) => JSON.parse(s.body.toString()).model).join(", ")}`);

  for (const kill of [false, true]) {
    n = stack.upstream.seen.length;
    const pid = await stack.workerPid();
    stack.upstream.setHandler((req, res, body) => {
      if (kill && stack.upstream.seen.length === n + 1 && pid) process.kill(pid, "SIGKILL"); // worker dies after the upstream got it, before headers
      setTimeout(() => { if (!res.destroyed) sseHandler(req, res, body); }, 300);
    });
    const r2 = await request(`${stack.url}/v1/messages?beta=true`, { method: "POST", ...at(mainNew, `c9b-${kill}`) }).catch((e) => ({ status: `error ${e.message}` }));
    await new Promise((r) => setTimeout(r, 500));
    console.log(`C9(2) kill worker mid-request=${kill}: client got ${r2.status}; upstream saw ${stack.upstream.seen.length - n} requests; door counters ${JSON.stringify(stack.door.counters)}`);
    if (kill) await waitFor(async () => (await stack.workerPid()) ?? null, { timeoutMs: 10_000 } as never).catch(() => undefined);
  }
  await stack.close();
}
await jev.close();
