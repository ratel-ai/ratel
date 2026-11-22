import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudEvent } from "@/lib/ingest/cloud-schema";
import { recordedReply } from "../recorded-reply";
import {
  type CompareRow,
  checkCompareSelection,
  compareSummary,
  itemLabel,
  MAX_COMPARE_ITEMS,
  openInSandboxHref,
  outputDiff,
  replayArm,
  runPool,
} from "../replay";

/**
 * Replay of recorded items (RC-1103): the recorded reply read from a model
 * call's payload, the Open in sandbox link, the compare selection limit, the
 * per-item output diff, the summary row and the bounded run pool.
 */

function call(partial: Partial<CloudEvent>): CloudEvent {
  return {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    ts: "2026-11-20T10:00:00Z",
    messages: [],
    ...partial,
  };
}

test("recordedReply reads the call's own output and parses JSON when it parses", () => {
  const payload = call({
    messages: [{ role: "user", content: "Label this" }],
    input_message_count: 1,
    output: [{ role: "assistant", content: [{ type: "text", text: '{"name":"Ship a fix"}' }] }],
  });
  assert.deepEqual(recordedReply(payload), { name: "Ship a fix" });
  assert.equal(
    recordedReply(call({ output: [{ role: "assistant", content: "plain words" }] })),
    "plain words",
  );
});

test("recordedReply falls back to the assistant messages after the input, and is null without any", () => {
  const payload = call({
    messages: [
      { role: "user", content: "Label this" },
      { role: "assistant", content: "[1, 2]" },
    ],
    input_message_count: 1,
  });
  assert.deepEqual(recordedReply(payload), [1, 2]);
  assert.equal(
    recordedReply(call({ messages: [{ role: "user", content: "hi" }], input_message_count: 1 })),
    null,
  );
  assert.equal(recordedReply(null), null);
});

test("openInSandboxHref links a production span with a sandbox input to the sandbox page", () => {
  const attributes = { "ratel.sandbox.id": "workflow-label", "ratel.sandbox.input": "{}" };
  assert.equal(
    openInSandboxHref("p 1", "abc123", attributes),
    "/project/p%201/sandboxes/workflow-label?span=abc123",
  );
  assert.equal(
    openInSandboxHref("p", "abc", { "ratel.sandbox.id": "workflow-label" }),
    null,
    "no input, nothing to open",
  );
  assert.equal(
    openInSandboxHref("p", "abc", { "ratel.sandbox.input": "{}" }),
    null,
    "no sandbox id",
  );
  assert.equal(
    openInSandboxHref("p", "abc", { ...attributes, "deployment.environment.name": "playground" }),
    null,
    "a playground run is not a recorded item",
  );
});

test("checkCompareSelection takes 1 to 50 distinct items", () => {
  assert.equal(MAX_COMPARE_ITEMS, 50);
  assert.equal(checkCompareSelection(["a", "b"]), null);
  assert.match(checkCompareSelection([]) ?? "", /at least 1/);
  assert.match(
    checkCompareSelection(Array.from({ length: 51 }, (_, i) => `s${i}`)) ?? "",
    /at most 50/,
  );
  assert.match(checkCompareSelection(["a", "a"]) ?? "", /once/);
});

test("replayArm is baseline with no edits and candidate with any", () => {
  assert.equal(replayArm([]), "baseline");
  assert.equal(replayArm(["maxTokens"]), "candidate");
});

test("outputDiff lists the changed keys of two objects, and the whole values otherwise", () => {
  assert.deepEqual(
    outputDiff(
      { name: "A", icon: "x", description: "d" },
      { name: "B", icon: "x", description: "d" },
    ),
    {
      same: false,
      changes: [{ path: "name", baseline: "A", candidate: "B" }],
    },
  );
  assert.deepEqual(outputDiff({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), {
    same: true,
    changes: [],
  });
  assert.deepEqual(outputDiff("x", "y"), {
    same: false,
    changes: [{ path: "", baseline: "x", candidate: "y" }],
  });
  assert.deepEqual(outputDiff({ a: 1 }, { a: 1, b: 2 }), {
    same: false,
    changes: [{ path: "b", baseline: undefined, candidate: 2 }],
  });
});

test("compareSummary adds tokens, cost and latency per arm over the finished runs and counts changed outputs", () => {
  const rows: CompareRow[] = [
    {
      baseline: {
        status: "ok",
        output: { name: "A" },
        metrics: { inputTokens: 100, outputTokens: 10, costUsd: 0.002, latencyMs: 1000 },
      },
      candidate: {
        status: "ok",
        output: { name: "B" },
        metrics: { inputTokens: 90, outputTokens: 8, costUsd: 0.001, latencyMs: 800 },
      },
    },
    {
      baseline: {
        status: "ok",
        output: { name: "C" },
        metrics: { inputTokens: 50, outputTokens: 5, costUsd: 0.001, latencyMs: 500 },
      },
      candidate: { status: "ok", output: { name: "C" }, metrics: null },
    },
    {
      baseline: { status: "error", output: null, metrics: null },
      candidate: { status: "running", output: null, metrics: null },
    },
  ];
  const summary = compareSummary(rows);
  assert.deepEqual(summary.baseline, {
    runs: 2,
    failed: 1,
    inputTokens: 150,
    outputTokens: 15,
    costUsd: 0.003,
    latencyMs: 1500,
  });
  assert.deepEqual(summary.candidate, {
    runs: 2,
    failed: 0,
    inputTokens: 90,
    outputTokens: 8,
    costUsd: 0.001,
    latencyMs: 800,
  });
  assert.equal(summary.compared, 2, "items where both arms ended ok");
  assert.equal(summary.changed, 1);
});

test("runPool runs every task with at most `limit` at once, in order of start", async () => {
  let running = 0;
  let peak = 0;
  const started: number[] = [];
  const tasks = Array.from({ length: 5 }, (_, i) => async () => {
    started.push(i);
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    return i * 2;
  });
  assert.deepEqual(await runPool(tasks, 2), [0, 2, 4, 6, 8]);
  assert.equal(peak, 2);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  assert.deepEqual(await runPool([async () => 1], 0), [1], "a limit under 1 runs one at a time");
});

test("itemLabel names an item by its first short text field, else its span", () => {
  assert.equal(
    itemLabel({ workflowId: "wf-refund", asks: ["a"] }, "81c583215710d8a3"),
    "wf-refund",
  );
  assert.equal(itemLabel({ asks: ["a"], n: 1 }, "81c583215710d8a3"), "Item 81c58321");
  assert.equal(itemLabel("{cut", "81c583215710d8a3"), "Item 81c58321");
  assert.equal(itemLabel({ ask: "x".repeat(200) }, "81c583215710d8a3"), `${"x".repeat(47)}…`);
});
