import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModelRestorer } from "../../src/wire/anthropic.js";

const START = 'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-4-5-20251001","id":"msg_1","content":[],"usage":{"input_tokens":2}}}\n\n';
const REST = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\\"model\\":\\"x\\" ✓"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

/** Feeds `text` split at every `step` bytes and returns what the client would get. */
function run(text: string, step: number, model = "claude-opus-5-5"): { out: string; restored: boolean } {
  const r = new ModelRestorer(model);
  const bytes = Buffer.from(text);
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += step) parts.push(r.push(bytes.subarray(i, i + step)));
  parts.push(r.end());
  return { out: Buffer.concat(parts).toString("utf8"), restored: r.restored };
}

describe("ModelRestorer", () => {
  it("puts the client's model into message_start whatever the chunking, and leaves every later byte alone", () => {
    const want = START.replace("claude-haiku-4-5-20251001", "claude-opus-5-5") + REST;
    for (const step of [1, 3, 7, 64, 100_000]) assert.deepEqual(run(START + REST, step), { out: want, restored: true }, `step ${step}`);
  });

  it("changes nothing when the first event is not message_start or has no model", () => {
    const err = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","model":"claude-haiku-4-5-20251001"}}\n\n';
    assert.deepEqual(run(err + START, 5), { out: err + START, restored: false });
    const noModel = START.replace('"model":"claude-haiku-4-5-20251001",', "");
    assert.deepEqual(run(noModel + REST, 5), { out: noModel + REST, restored: false });
  });

  it("hands back a stream that ends before its first event does, unchanged", () => {
    const cut = START.slice(0, 40);
    assert.deepEqual(run(cut, 4), { out: cut, restored: false });
  });

  it("gives up after 64 KiB without an event end and passes everything on", () => {
    const big = "data: " + "x".repeat(70 * 1024) + "\n\n" + START;
    assert.deepEqual(run(big, 4096), { out: big, restored: false });
  });
});
