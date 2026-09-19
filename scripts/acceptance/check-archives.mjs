#!/usr/bin/env node
// Phase 1 acceptance: the criteria that can be checked from archived decision logs (docs/acceptance-phase1.md).
//   node scripts/acceptance/check-archives.mjs [archiveDir=~/.reflex/archive]
// Reads JSONL only. Prints PASS / FAIL / NOTE lines per criterion with the evidence (record ids are shortened). Exit 1 on any FAIL.
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2] ?? join(homedir(), ".reflex", "archive");
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
const load = (f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const logs = Object.fromEntries(files.map((f) => [f.replace(/\.jsonl$/, ""), load(f)]));
const decisions = (recs) => recs.filter((r) => (r.record ?? "decision") === "decision");
const tier = (m) => ["haiku", "sonnet", "opus", "fable"].find((t) => (m ?? "").includes(t)) ?? null;
const sent = (d) => tier(d.forwarded?.model ?? d.requested?.model);
const req = (d) => tier(d.requested?.model);
const short = (id) => id.slice(0, 8);

let failed = 0;
const out = (level, id, msg) => {
  if (level === "FAIL") failed++;
  console.log(`${level.padEnd(4)} ${id}  ${msg}`);
};
const check = (id, ok, pass, fail) => out(ok ? "PASS" : "FAIL", id, ok ? pass : fail);

// --- 2. shadow-1: one full decision per user turn, zero degrade, zero unclassified, nothing changed
{
  const d = decisions(logs["shadow-1"] ?? []);
  const news = d.filter((x) => x.turn === "new");
  check("2a", news.length > 0 && news.every((x) => x.decision), `${news.length} new turns (${news.filter((x) => x.kind === "main").length} main, ${news.filter((x) => x.kind === "subagent").length} subagent), every one has a backend decision`, `${news.filter((x) => !x.decision).length} new turns without a decision`);
  const dupPerRequest = d.filter((x) => x.decision && x.turn !== "new").length;
  check("2b", dupPerRequest === 0, "the backend was asked for new turns only (no decision on continuation or side records)", `${dupPerRequest} non-new records carry a decision`);
  const degraded = d.filter((x) => x.degraded_reason || x.mode_effective !== "shadow" || (x.shape?.violations ?? []).length > 0);
  check("2c", degraded.length === 0, "zero degraded records, zero shape violations, mode shadow throughout", `${degraded.length} degraded records`);
  const unclassified = d.filter((x) => x.side_kind === "unclassified" || x.turn === "unknown" || (x.turn === "side" && !x.side_kind));
  check("2d", unclassified.length === 0, "zero unclassified requests", `${unclassified.length} unclassified`);
  const changed = d.filter((x) => x.forwarded?.rewritten || x.forwarded?.model !== x.requested?.model);
  check("2e", changed.length === 0, `all ${d.length} requests forwarded on the requested model, none rewritten`, `${changed.length} records changed`);
  out("NOTE", "2f", "byte-identical forwarding is asserted by tests (shadow.test.ts 'replays every fixture'), not visible in a log");
}

// --- 3. subagent routed and pinned through its tool loop
{
  let routedAgents = 0;
  const bad = [];
  for (const [name, recs] of Object.entries(logs)) {
    const d = decisions(recs).filter((x) => x.kind === "subagent" && x.mode_effective === "route");
    const byConv = new Map();
    for (const x of d) byConv.set(x.conv, [...(byConv.get(x.conv) ?? []), x]);
    for (const [conv, list] of byConv) {
      list.sort((a, b) => a.at.localeCompare(b.at));
      const first = list.find((x) => x.turn === "new");
      if (!first || !first.forwarded?.rewritten || first.forwarded?.fallback) continue;
      routedAgents++;
      const target = sent(first);
      for (const x of list.filter((y) => y.turn === "continuation")) if (sent(x) !== target || x.pin !== "hit") bad.push(`${name}:${short(x.id)} sent ${sent(x)} pin ${x.pin}`);
      out("NOTE", "3", `${name} ${conv.slice(-8)}: ${req(first)} -> ${target}, ${list.filter((y) => y.turn === "continuation").length} continuations`);
    }
  }
  check("3", routedAgents > 0 && bad.length === 0, `${routedAgents} routed subagents stayed on their tier for every continuation (pin hit)`, `${routedAgents === 0 ? "no routed subagent found" : bad.join("; ")}`);
}

// --- 4. main chat: routed only behind the guard (first turn = fresh); refusals stay put; no unexplained return to the requested model
{
  // route-1 holds session B's first run, recorded before the stay_pinned fix: a guard refusal sent the conversation back to Opus (docs/m5-handoff.md, archived logs).
  const PRE_FIX = new Set(["route-1"]);
  const ORDER = ["haiku", "sonnet", "opus", "fable"];
  const all = Object.entries(logs).flatMap(([n, l]) => decisions(l).filter((x) => x.kind === "main" && x.mode_effective === "route" && x.turn === "new").map((x) => ({ n, x })));
  const rewritten = all.filter(({ x }) => x.forwarded?.rewritten && !x.forwarded?.fallback);
  // Only a move to a cheaper tier than the one holding the conversation's cache is guarded (src/worker/router.ts): staying on the
  // pin and moving up (return_up) never are, and an explicit `reflex:<tier>` override is the user's choice.
  const why = (x) => (x.guard?.allowed && ["fresh", "within_limit", "no_switch"].includes(x.guard.reason) ? `guard:${x.guard.reason}` : ["stay_pinned", "return_up", "override"].find((r) => (x.plan?.reasons ?? []).includes(r)) ?? "UNGUARDED");
  const reasons = rewritten.map(({ x }) => why(x));
  const byReason = reasons.reduce((m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {});
  check("4a", rewritten.length > 0 && !reasons.includes("UNGUARDED"), `${rewritten.length} rewritten main-chat new turns, each either passed the guard or did not leave the cache holder's tier: ${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(", ")}`, `${reasons.filter((r) => r === "UNGUARDED").length} rewritten main-chat turns are neither guarded nor a pin/return_up/override`);
  const refused = all.filter(({ x }) => x.guard && !x.guard.allowed);
  const wrongSide = refused.filter(({ x }) => x.forwarded?.rewritten);
  check("4b", refused.length > 0 && wrongSide.length === 0, `${refused.length} guard refusals (${[...new Set(refused.map(({ x }) => x.guard.reason))].join(", ")}); none was rewritten to a cheaper tier`, refused.length === 0 ? "no guard refusal in the archives" : `${wrongSide.length} refused turns were rewritten anyway`);
  // Per conversation: after a downgrade, a later new turn back on the requested tier needs an override, a return_up or a guard refusal.
  const byConv = new Map();
  for (const e of all) byConv.set(e.x.conv, [...(byConv.get(e.x.conv) ?? []), e]);
  const bounces = [];
  const moved = [];
  const movedPreFix = [];
  for (const [conv, list] of byConv) {
    list.sort((a, b) => a.x.at.localeCompare(b.x.at));
    list.forEach(({ x }, i) => {
      if (x.guard && !x.guard.allowed && sent(x) !== (i > 0 ? sent(list[i - 1].x) : req(x))) (PRE_FIX.has(list[0].n) ? movedPreFix : moved).push(`${list[0].n}:${short(x.id)}`);
    });
    if (list.some(({ x }) => x.forwarded?.rewritten)) out("NOTE", "4", `${list[0].n} ${conv.slice(-8)}: new turns ${list.map(({ x }) => `${sent(x)}${x.override ? "(override)" : ""}${x.guard && !x.guard.allowed ? `[guard ${x.guard.reason}]` : ""}`).join(" > ")}`);
    list.forEach(({ x }, i) => {
      const prev = list[i - 1]?.x;
      if (prev && sent(prev) !== req(prev) && sent(x) === req(x) && !x.override && !(x.plan?.reasons ?? []).some((r) => ["return_up", "guard_blocked", "same_tier"].includes(r)) && ORDER.indexOf(sent(x)) > ORDER.indexOf(sent(prev))) bounces.push(`${list[0].n}:${short(x.id)}`);
    });
  }
  if (movedPreFix.length > 0) out("NOTE", "4b2", `pre-fix archive route-1: ${movedPreFix.length} refused turn(s) went back to the requested tier (${movedPreFix.join(", ")}); this is the bug the stay_pinned fix closed`);
  check("4b2", moved.length === 0, `in the post-fix archives (route-2, route-3, m4-acceptance) each refused turn was sent on the tier the conversation was already on (previous new turn, else the requested tier)`, `refused turns that changed tier: ${moved.join(", ")}`);
  check("4c", bounces.length === 0, "no pinned conversation went back to its requested model without an override, a return_up or a guard refusal", `unexplained returns to the requested model: ${bounces.join(", ")}`);
  out("NOTE", "4d", "'does not bounce back to Opus' (session B repeat = route-3 above): haiku -> sonnet (return_up on the backend's own pick) -> opus only by explicit override");
}

// --- 5. overrides
{
  const ov = Object.entries(logs).flatMap(([n, l]) => decisions(l).filter((x) => x.override).map((x) => ({ n, x })));
  check("5a", ov.length > 0, `${ov.length} records with an override: ${ov.map(({ n, x }) => `${n}:${short(x.id)} ${x.override} -> sent ${sent(x)}${x.forwarded?.fallback ? " (fallback)" : ""}`).join("; ")}`, "no override record in the archives");
  const applied = ov.filter(({ x }) => sent(x) === x.override || (x.plan?.reasons ?? []).includes("same_tier") || x.forwarded?.fallback);
  check("5b", applied.length === ov.length, "every override was applied, was already on that tier, or was rejected upstream and re-sent (fallback)", `${ov.length - applied.length} overrides neither applied nor explained`);
  out("NOTE", "5c", "the '!' prefix is not used: src/overrides.ts accepts only 'reflex:<tier>' (Claude Code consumes '!' as bash mode)");
}

// --- 6. rejected rewrite reverts to the original bytes and the error is logged
{
  const fb = Object.entries(logs).flatMap(([n, l]) => decisions(l).filter((x) => x.forwarded?.fallback).map((x) => ({ n, x })));
  check("6a", fb.length > 0, `${fb.length} fallback records`, "no fallback record in the archives");
  const notReverted = fb.filter(({ x }) => x.forwarded.model !== x.requested.model || x.forwarded.rewritten || x.upstream?.status !== 200);
  check("6b", notReverted.length === 0, "every fallback record shows the requested model as sent, rewritten=false, and the re-sent request's status 200", `${notReverted.length} fallback records do not show a clean revert`);
  const withErr = fb.filter(({ x }) => x.forwarded.fallback_error);
  out(withErr.length > 0 ? "PASS" : "FAIL", "6c", `${withErr.length} of ${fb.length} fallback records carry the upstream's error text: ${withErr.map(({ x }) => JSON.stringify(x.forwarded.fallback_error).slice(0, 90)).join("; ")}`);
  const legacy = fb.filter(({ x }) => !("fallback_error" in x.forwarded));
  if (legacy.length > 0) out("NOTE", "6d", `${legacy.length} fallback record(s) predate the fallback_error field (route-1, session A1); their status is logged (${legacy.map(({ x }) => x.forwarded.fallback_status).join(",")}) but not the message`);
  const rewritten = Object.entries(logs).flatMap(([n, l]) => decisions(l).filter((x) => x.forwarded?.rewritten).map((x) => ({ n, x })));
  const incomplete = rewritten.filter(({ x }) => !x.forwarded.requested_model || !x.forwarded.model || !Array.isArray(x.forwarded.fields) || x.forwarded.fields.length === 0);
  check("6f", rewritten.length > 0 && incomplete.length === 0, `all ${rewritten.length} routed (rewritten) records list requested model, sent model and the rewritten fields`, `${incomplete.length} of ${rewritten.length} routed records lack one of them: ${incomplete.slice(0, 5).map(({ n, x }) => `${n}:${short(x.id)}`).join(", ")}`);
  const tierOff = Object.values(logs).flatMap((l) => decisions(l)).filter((x) => (x.plan?.reasons ?? []).includes("tier_disabled"));
  out("NOTE", "6e", `${tierOff.length} records show tier_disabled after a rejection`);
}

// --- 7. Jev unreachable: forwarded unchanged
{
  const errs = Object.entries(logs).flatMap(([n, l]) => decisions(l).filter((x) => x.error && /^backend:|breaker_open|decision_late/.test(x.error)).map((x) => ({ n, x })));
  const ok = errs.filter(({ x }) => !x.forwarded?.rewritten && x.forwarded?.model === x.requested?.model && x.upstream?.status === 200);
  check("7a", errs.length > 0 && ok.length === errs.length, `${errs.length} records with a backend error (${[...new Set(errs.map(({ x }) => x.error))].join(", ")}): all forwarded on the requested model, unchanged, upstream 200`, errs.length === 0 ? "no backend error in the archives" : `${errs.length - ok.length} error records were not forwarded unchanged`);
  const timed = errs.filter(({ x }) => x.timing);
  const GRACE = 250; // src/timing.ts
  if (timed.length > 0) {
    const over = timed.filter(({ x }) => x.timing.decision_wait_ms > x.timing.decision_deadline_ms + GRACE);
    check("7c", over.length === 0, `${timed.length} of ${errs.length} timed-out/failed decisions carry a timing block; longest decision wait ${Math.max(...timed.map(({ x }) => x.timing.decision_wait_ms))} ms, all within deadline + ${GRACE} ms grace`, `${over.length} decisions waited longer than deadline + ${GRACE} ms`);
  }
  if (timed.length < errs.length) out("NOTE", "7c", `${errs.length - timed.length} of ${errs.length} backend-error records predate the timing block (decision_wait_ms / upstream_first_byte_ms); their time to response headers (${errs.filter(({ x }) => !x.timing).map(({ x }) => `${x.upstream?.msToHeaders} ms`).join(", ")}) mixes the decision wait with the model's own time, so the deadline cannot be verified from them: needs a session recorded on a build with the timing block`);
  out("NOTE", "7b", "corrupt config and kill -9 of the worker have no archived session: they are covered by tests (see docs/acceptance-phase1.md)");
}

// --- 8. outcome linkage (m4-acceptance)
{
  const recs = logs["m4-acceptance"] ?? [];
  const outs = recs.filter((r) => r.record === "outcome");
  const ids = new Set(decisions(recs).map((d) => d.id));
  const joined = outs.filter((o) => o.decision_id);
  check("8a", joined.every((o) => ids.has(o.decision_id)), `${joined.length} of ${outs.length} outcome records join to a decision in the same log`, "an outcome record points at a missing decision");
  const unj = outs.filter((o) => !o.decision_id);
  const post = unj.filter((o) => o.counts && "injected_prompts" in o.counts); // written by the current tracker
  const pre = unj.filter((o) => !(o.counts && "injected_prompts" in o.counts));
  check("8b", post.every((o) => o.no_decision?.reason), `${post.length} decision-less outcome records from the current tracker, each says why`, `${post.filter((o) => !o.no_decision?.reason).length} current-format outcome records without a no_decision reason`);
  if (pre.length > 0) out("NOTE", "8b", `${pre.length} decision-less outcome record(s) predate the no_decision field and carry no reason (seq ${pre.map((o) => o.turn_seq).join(", ")}); not fixable retroactively`);
  const upd = recs.filter((r) => r.record === "outcome_update");
  check("8c", upd.length > 0 && upd.every((u) => ids.has(u.decision_id)), `${upd.length} outcome_update (${upd.map((u) => u.detail?.kind + " offset " + u.detail?.offset_turns).join(", ")}) joined to its decision`, "no outcome_update or an unjoined one");
  const tf = outs.filter((o) => o.signals?.test_failure_after_edit?.detected);
  check("8d", tf.length > 0, `${tf.length} test_failure_after_edit (${tf.map((o) => o.signals.test_failure_after_edit.runs.map((r) => r.kind + " exit " + r.exit_code).join(",")).join("; ")})`, "no test failure recorded");
  const corr = outs.filter((o) => (o.signals?.correction?.score ?? 0) > 0);
  check("8e", corr.length > 0, `${corr.length} correction score > 0: ${corr.map((o) => `seq ${o.turn_seq} ${o.signals.correction.score} ${o.signals.correction.matched.join("+")}`).join("; ")}`, "no correction recorded");
  const sub = outs.filter((o) => o.scope === "subagent" && o.decision_id);
  const subDec = sub.map((o) => decisions(recs).find((d) => d.id === o.decision_id));
  check("8f", sub.length > 0 && subDec.every((d) => d?.kind === "subagent"), `${sub.length} subagent-scope outcome joined to a subagent decision`, "subagent outcome not joined to a subagent decision");
  const noDec = outs.filter((o) => !o.decision_id);
  out("NOTE", "8g", `injected messages: ${noDec.length} windows without a decision (seq ${noDec.map((o) => o.turn_seq).join(", ")}) were recorded BEFORE the injected-message fix; the fix is verified by test/unit/outcome.test.ts 'session 2 seq 5/6 replay', not by this archive`);
}

// --- 10. leak scan. Criterion (reworded 2026-09-19): no secrets, no home-directory paths, no user text beyond the redacted
// prompt preview (<= 300 code points); project-relative paths are acceptable; REFLEX_LOG_PROMPTS=0 removes the preview.
{
  const patterns = { "home path": /\/(Users|home)\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\/, "sk- key": /sk-[A-Za-z0-9_-]{8,}/, "apikey_": /apikey_[A-Za-z0-9]/, "AWS key": /AKIA[0-9A-Z]{12,}/, "GitHub token": /gh[pousr]_[A-Za-z0-9]{20,}/, "Bearer/Authorization": /(bearer|authorization)\s*[:=]?\s*[A-Za-z0-9._-]{12,}/i, JWT: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, "PEM key": /-----BEGIN [A-Z ]*PRIVATE KEY/ };
  let lines = 0;
  const hits = {};
  let previews = 0;
  let maxPreview = 0;
  let relPaths = 0;
  const freeText = new Set();
  for (const [n, recs] of Object.entries(logs)) {
    for (const r of recs) {
      lines++;
      const s = JSON.stringify(r);
      for (const [k, re] of Object.entries(patterns)) if (re.test(s)) (hits[k] ??= []).push(`${n}:${short(r.id)}`);
      if (typeof r.prompt_preview === "string") {
        previews++;
        maxPreview = Math.max(maxPreview, [...r.prompt_preview].length);
        if (/[\w.-]+\/[\w./-]+\.\w+|\b(src|test|docs)\//.test(r.prompt_preview)) relPaths++;
      }
      // Every string value that is long enough to be prose, other than the two documented text fields, is suspicious.
      const walk = (v, path) => {
        if (typeof v === "string") {
          if (v.length > 30 && !/^[0-9a-f:.-]{16,}$/.test(v) && !["at", "prompt_preview", "forwarded.fallback_error"].includes(path) && !/^(claude-|jev-)/.test(v) && !(path === "conv" && /^[0-9a-f]{16}:[ma]:[0-9a-f]{16}$/.test(v)) && !(path.startsWith("forwarded.fields.") && /^[a-z_.:\-0-9]+$/.test(v))) freeText.add(`${r.record ?? "decision"}.${path}`);
        } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
      };
      walk(r, "");
    }
  }
  check("10a", Object.keys(hits).length === 0, `${lines} records scanned: no home-directory path, API key, token, JWT, PEM or Authorization value`, `secret/path shapes found: ${Object.entries(hits).map(([k, v]) => `${k} ${v.join(",")}`).join("; ")}`);
  check("10b", freeText.size === 0, "no free-text field other than prompt_preview and forwarded.fallback_error (the upstream's redacted error message) in any record; outcome / outcome_update / harness_injected records hold only hashes, counts and rule ids", `unexpected free-text fields: ${[...freeText].join(", ")}`);
  check("10c", maxPreview <= 300, `${previews} prompt_preview fields, longest ${maxPreview} code points (cap 300)`, `a preview exceeds the 300-code-point cap (${maxPreview})`);
  out("NOTE", "10d", `${relPaths} of ${previews} previews contain a project-relative path (e.g. src/...): acceptable under the criterion; home-directory prefixes are redacted to ~ (10a). The preview is on by default and will be revisited before a public release; REFLEX_LOG_PROMPTS=0 removes it (test/unit/decision-log.test.ts).`);
}

console.log(failed === 0 ? "\nno FAIL lines" : `\n${failed} FAIL line(s)`);
process.exit(failed === 0 ? 0 : 1);
