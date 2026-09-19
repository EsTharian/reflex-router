// The labelled reasoning-vs-length prompt set for test/live/jev.live.test.ts.
//
// 30 prompts, each labelled by the tier the AUTHOR judges adequate from the reasoning the task demands. The labels are one
// person's judgment, not ground truth; the set exists to see whether the tier question follows reasoning or message size.
// Cells: short-hard (opus) and long-easy (haiku) are the discordant ones, where a length-driven judge would be wrong.
import type { Tier } from "../../src/config.js";

export type Length = "short" | "long";
export interface LabelledPrompt {
  readonly id: string;
  readonly cell: "short-hard" | "long-easy" | "short-easy" | "long-hard" | "mid";
  readonly length: Length;
  readonly label: Tier;
  readonly task: string;
}

const lines = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n");

const consts = lines(60, (i) => `export const FLAG_${i} = ${i * 3};`);
const files = lines(80, (i) => (i % 7 === 0 ? `docs/notes-${i}.md` : `src/module-${i}/index.ts`));
const json = `{\n${lines(45, (i) => `"key${i}":{"id":${i},"name":"item-${i}","tags":["a","b"],"active":${i % 2 === 0}}${i < 45 ? "," : ""}`)}\n}`;
const imports = lines(70, (i) => `import { thing${(i * 37) % 71} } from "./lib/mod${(i * 11) % 23}.js";`);
const quotes = lines(50, (i) => `const label${i} = 'value number ${i}';`);
const log = lines(70, (i) => `2026-09-19T10:${String(i % 60).padStart(2, "0")}:00Z ${i % 9 === 0 ? "ERROR" : "INFO"} worker-${i % 4} handled request ${i}`);
const stack = `TypeError: Cannot read properties of undefined (reading 'tier')\n${lines(30, (i) => `    at fn${i} (/app/src/router/step${i}.ts:${10 + i}:${i % 9 + 3})`)}`;
const fn40 = `function applyDiscount(order, code) {\n${lines(36, (i) => `  const step${i} = order.items[${i % 5}].price * ${1 + (i % 3)} - ${i};`)}\n  return order.total - step1;\n}`;
const envTable = lines(12, (i) => `| REFLEX_SETTING_${i} | ${i % 2 ? "integer" : "on/off"} | ${i * 10} | what setting ${i} controls |`);

const corruption =
  "We have three services: ingest (writes events to Kafka), enrich (reads Kafka, joins with a Postgres table, writes to a second topic) and store (reads the second topic, upserts into ClickHouse). " +
  "About 1 in 10 million rows in ClickHouse has the enrich fields from a DIFFERENT event with the same customer id. It only happens within a minute or two of a Postgres failover, never in staging. " +
  "enrich uses a connection pool with a 30 s validation interval and a per-partition in-memory cache keyed by customer id with a 5 s TTL. store batches upserts by 5000 rows and retries the whole batch on any error. " +
  "Logs around the incidents show a burst of `connection reset` in enrich followed by consumer rebalances, and store logging `duplicate batch` twice. " +
  lines(12, (i) => `Sample incident ${i}: event ${i}a arrived at ${i} s, cache entry refreshed at ${i + 3} s, rebalance at ${i + 2} s.`) +
  "\nFind the root cause and tell me what to change, and how you would prove it before shipping.";
const design =
  "We must replace our monolith's in-process job queue with something durable. Constraints: exactly-once effect for billing jobs, at-least-once for email jobs, per-tenant fairness so one tenant cannot starve the others, " +
  "jobs may run up to 6 hours, we deploy 20 times a day with rolling restarts, we have Postgres and Redis but no Kafka and no appetite to run one, the team is five people, and billing jobs must be auditable for 7 years. " +
  lines(10, (i) => `Requirement R${i}: ${["latency under 200 ms to enqueue", "no lost jobs on deploy", "operators can pause one tenant", "retries with backoff and a poison-job limit", "cost stays flat at 10x volume"][i % 5]} (owner team ${i % 3}).`) +
  "\nPropose the architecture, the failure modes it does not cover, and the order in which to migrate the 14 job types.";
const authFlow =
  "Review this auth flow for vulnerabilities. Login posts credentials to /login which returns a signed session cookie (HMAC-SHA256, key from env, payload `uid|role|expiry`). " +
  "Password reset emails a link with a token that is `base64(uid + ':' + Date.now())`. The admin panel checks `role` from the cookie payload. Cookies are `HttpOnly` but not `Secure`; expiry is checked with `<` on a string comparison. " +
  lines(14, (i) => `  // line ${i}: if (payload.split("|")[${i % 3}] === expected) allow();`) +
  "\nList what is exploitable, in order of severity, with the exact request an attacker would send.";
const perf =
  "After upgrading the runtime our p99 latency doubled, but only for tenants with more than 10k rows, only after ~20 minutes of uptime, and CPU stays flat. Heap grows slowly, GC pauses look normal, the DB is idle, " +
  "flame graphs before and after look identical except a slightly wider `serialize` frame. " +
  lines(12, (i) => `Sample ${i}: uptime ${i * 5} min, p99 ${100 + i * 15} ms, heap ${200 + i * 9} MB, open sockets ${40 + i}.`) +
  "\nWork out what is going on and how to confirm it with the fewest experiments.";
const migration =
  "Design the zero-downtime migration of our orders table (900M rows, three writers, two of them third-party) from a single-column integer key to a composite tenant+uuid key, " +
  "while keeping every foreign key valid, replicas within 2 s of lag, and the ability to roll back within an hour at any step. " +
  lines(10, (i) => `Table T${i} references orders through ${["a FK", "a view", "a materialized view", "an app-level join", "a trigger"][i % 5]} and is written by ${["us", "vendor A", "vendor B"][i % 3]}.`) +
  "\nGive the step sequence and what could go wrong at each step.";
const flaky =
  "A distributed integration test fails about 1 run in 40. Timeline from the last three failures: node B acks a write, node A reads stale data 30-80 ms later, the test then asserts on it. " +
  "Clocks are NTP-synced within 5 ms; reads use `quorum`; the client library retries idempotent reads on timeout and caches leader address for 100 ms. " +
  lines(12, (i) => `Run ${i}: write ack at t=${i * 1000 + 3} ms, read at t=${i * 1000 + 40} ms, leader change at t=${i * 1000 + 20} ms.`) +
  "\nExplain the failure mechanism and whether the test or the system is wrong.";

export const REASONING_SET: readonly LabelledPrompt[] = [
  // short, hard: the reply is meant to be tiny, the reasoning is not
  { id: "sh1", cell: "short-hard", length: "short", label: "opus", task: "Why would two replicas both believe they hold the lock after a network partition heals? Answer in one line." },
  { id: "sh2", cell: "short-hard", length: "short", label: "opus", task: "Our nightly job corrupts about 1 row in 10 million, only when a DB failover overlaps a batch. Root cause? One sentence." },
  { id: "sh3", cell: "short-hard", length: "short", label: "opus", task: "Is it safe to load the user from `jwt.decode(token, options={'verify_signature': False}).get('sub')`? One word, then one reason." },
  { id: "sh4", cell: "short-hard", length: "short", label: "opus", task: "Prove or refute: a 2PC coordinator crash after every participant voted yes but before commit can never block them. Two lines." },
  { id: "sh5", cell: "short-hard", length: "short", label: "opus", task: "What is the smallest change that makes cache invalidation correct across 40 services? Three bullets, three words each." },
  { id: "sh6", cell: "short-hard", length: "short", label: "opus", task: "Why does this test pass alone and fail in the full suite, only on CI, only sometimes? Be terse." },
  // long, easy: a lot of text, no reasoning
  { id: "le1", cell: "long-easy", length: "long", label: "haiku", task: `Rename the prefix FLAG_ to OPT_ in every line below and print the result:\n${consts}` },
  { id: "le2", cell: "long-easy", length: "long", label: "haiku", task: `How many of these paths end in .md?\n${files}` },
  { id: "le3", cell: "long-easy", length: "long", label: "haiku", task: `Reformat this JSON with 2-space indentation:\n${json}` },
  { id: "le4", cell: "long-easy", length: "long", label: "haiku", task: `Sort these imports alphabetically by module path:\n${imports}` },
  { id: "le5", cell: "long-easy", length: "long", label: "haiku", task: `Change single quotes to double quotes on every line:\n${quotes}` },
  { id: "le6", cell: "long-easy", length: "long", label: "haiku", task: `Count the lines containing ERROR in this log:\n${log}` },
  // short, easy
  { id: "se1", cell: "short-easy", length: "short", label: "haiku", task: "What does src/wire export? Just list the function names." },
  { id: "se2", cell: "short-easy", length: "short", label: "haiku", task: "Run the tests and tell me whether they pass." },
  { id: "se3", cell: "short-easy", length: "short", label: "haiku", task: "Where is `loadConfig` defined?" },
  { id: "se4", cell: "short-easy", length: "short", label: "haiku", task: "Rename the variable `tmp` to `buffer` in utils.ts." },
  { id: "se5", cell: "short-easy", length: "short", label: "haiku", task: "Print the current git branch." },
  { id: "se6", cell: "short-easy", length: "short", label: "haiku", task: "Add a trailing newline to README.md." },
  // long, hard
  { id: "lh1", cell: "long-hard", length: "long", label: "opus", task: corruption },
  { id: "lh2", cell: "long-hard", length: "long", label: "opus", task: design },
  { id: "lh3", cell: "long-hard", length: "long", label: "opus", task: authFlow },
  { id: "lh4", cell: "long-hard", length: "long", label: "opus", task: perf },
  { id: "lh5", cell: "long-hard", length: "long", label: "opus", task: migration },
  { id: "lh6", cell: "long-hard", length: "long", label: "opus", task: flaky },
  // ordinary work
  { id: "md1", cell: "mid", length: "short", label: "sonnet", task: "Add a --json flag to the `report` command and cover it with a test." },
  { id: "md2", cell: "mid", length: "short", label: "sonnet", task: "Fix the failing test in test/unit/policy.test.ts; it says expected 'sonnet' but got 'haiku'." },
  { id: "md3", cell: "mid", length: "short", label: "sonnet", task: "Summarise how the supervisor restarts the worker and where the backoff is configured." },
  { id: "md4", cell: "mid", length: "long", label: "sonnet", task: `Fix this error; the cause is in our own code:\n${stack}` },
  { id: "md5", cell: "mid", length: "long", label: "sonnet", task: `Add input validation and unit tests to this function:\n${fn40}` },
  { id: "md6", cell: "mid", length: "long", label: "sonnet", task: `Write a README section documenting these settings:\n${envTable}` },
];
