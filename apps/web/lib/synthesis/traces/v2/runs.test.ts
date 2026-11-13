import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_TRACE_AGGREGATE } from "@/lib/synthesis/traces/queries";
import type { TraceSummaryView } from "@/lib/synthesis/traces/view";
import {
  HIGH_ERROR_RATE,
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  runStats,
  runStatus,
  toRunRow,
  visibleTools,
} from "./runs";

const summary: TraceSummaryView = {
  traceId: "ba036105ab6de43e0000000000000001",
  rootSpanId: "ba036105ab6de43e",
  rootName: "invoke_agent support-agent",
  startedAt: "2026-10-09T12:00:35.578Z",
  endedAt: "2026-10-09T12:00:35.578Z",
  durationMs: 0,
  statusCode: 1,
  serviceName: "langfuse-import",
  spanCount: 3,
  errorCount: 1,
  inputTokens: 300,
  outputTokens: 40,
  totalTokens: 340,
  costUsd: 0,
  experimentName: null,
  experimentArm: null,
};

test("a run reads as its ask when captured, else as its root in plain words", () => {
  const named = toRunRow(summary, { tools: ["search_docs"], prompt: null });
  assert.equal(named.title, "support-agent");
  assert.equal(named.titleIsAsk, false);
  assert.equal(named.status, "failed", "one failed step fails the run");
  const asked = toRunRow(summary, { tools: [], prompt: "  Where is\norder 1234?  " });
  assert.equal(asked.title, "Where is order 1234?");
  assert.equal(asked.titleIsAsk, true);
  assert.equal(toRunRow(summary).tools.length, 0, "no details: no tools, still a row");
});

test("status is failed for a failed root or any failed step", () => {
  assert.equal(runStatus(2, 0), "failed");
  assert.equal(runStatus(1, 3), "failed");
  assert.equal(runStatus(0, 0), "completed", "an unset root status without errors completed");
});

test("a run without its top-level span is incomplete, and says so with a neutral dot", () => {
  assert.equal(runStatus(0, 0, false), "incomplete");
  assert.equal(runStatus(0, 1, false), "failed", "a failed step still fails it");
  const row = toRunRow({ ...summary, errorCount: 0 }, { tools: [], prompt: null, hasRoot: false });
  assert.equal(row.status, "incomplete");
  assert.equal(RUN_STATUS_LABEL[row.status], "Incomplete");
  assert.equal(RUN_STATUS_TONE[row.status], "neutral");
  assert.equal(
    toRunRow({ ...summary, errorCount: 0 }, { tools: [], prompt: null }).status,
    "completed",
    "unknown claims nothing",
  );
});

test("three tools show, the rest are counted", () => {
  assert.deepEqual(visibleTools(["a", "b", "c", "d", "e"]), { shown: ["a", "b", "c"], more: 2 });
  assert.deepEqual(visibleTools(["a"]), { shown: ["a"], more: 0 });
});

test("the key numbers are five, with p95 beside the median and a danger mark only when the rate is high", () => {
  const stats = runStats({
    ...EMPTY_TRACE_AGGREGATE,
    count: 12_400,
    errorCount: 744,
    errorRate: 0.06,
    p50DurationMs: 1840,
    p95DurationMs: 6120,
    totalTokens: 724_118,
    costUsd: 9.372753,
  });
  assert.deepEqual(
    stats.map((stat) => [
      stat.label,
      stat.value.replaceAll("\u00a0", " "),
      stat.hint?.replaceAll("\u00a0", " "),
      stat.tone,
    ]),
    [
      ["Runs", "12.4K", undefined, undefined],
      ["Error rate", "6%", "744 failed", "danger"],
      ["Median duration", "1.8 s", "p95 6.1 s", undefined],
      ["Tokens", "724.1K", undefined, undefined],
      ["Cost", "$9.37", undefined, undefined],
    ],
  );
  const calm = runStats({
    ...EMPTY_TRACE_AGGREGATE,
    count: 60,
    errorCount: 0,
    errorRate: 0,
    p50DurationMs: 0,
    p95DurationMs: 0,
  });
  assert.equal(calm[1].hint, "No failed runs");
  assert.equal(calm[1].tone, undefined);
  const justBelow = runStats({
    ...EMPTY_TRACE_AGGREGATE,
    count: 100,
    errorCount: 4,
    errorRate: HIGH_ERROR_RATE - 0.01,
  });
  assert.equal(justBelow[1].tone, undefined);
});
