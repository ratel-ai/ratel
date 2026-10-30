import assert from "node:assert/strict";
import { test } from "node:test";
import type { OtelSpan } from "@/lib/ingest/otlp/schema";
import { summarizeTraceForComparison } from "./comparison";

test("summarizeTraceForComparison uses the earliest root and aggregates trace metrics", () => {
  const laterRoot = span({
    traceId: "right-trace",
    spanId: "root-z",
    name: "later.root",
    startedAt: new Date("2026-07-30T10:00:01.000Z"),
    endedAt: new Date("2026-07-30T10:00:01.500Z"),
    durationMs: 500,
  });
  const root = span({
    traceId: "right-trace",
    spanId: "root-a",
    name: "agent.run",
    serviceName: "checkout-agent",
    startedAt: new Date("2026-07-30T10:00:00.000Z"),
    endedAt: new Date("2026-07-30T10:00:00.400Z"),
    durationMs: 400,
    inputTokens: 10,
    costUsd: "0.001000",
  });
  const child = span({
    traceId: "right-trace",
    spanId: "child",
    parentSpanId: root.spanId,
    name: "chat",
    statusCode: 2,
    outputTokens: 4,
    costUsd: "0.002500",
    experimentName: "ranking-v2",
    experimentArm: "candidate",
  });

  assert.deepEqual(summarizeTraceForComparison([child, laterRoot, root]), {
    traceId: "right-trace",
    rootName: "agent.run",
    startedAt: new Date("2026-07-30T10:00:00.000Z"),
    endedAt: new Date("2026-07-30T10:00:00.400Z"),
    durationMs: 400,
    statusCode: 1,
    serviceName: "checkout-agent",
    spanCount: 3,
    errorCount: 1,
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    costUsd: 0.0035,
    experimentName: "ranking-v2",
    experimentArm: "candidate",
  });
});

test("summarizeTraceForComparison rejects an empty trace", () => {
  assert.throws(() => summarizeTraceForComparison([]), /at least one span/i);
});

function span(overrides: Partial<OtelSpan> = {}): OtelSpan {
  const startedAt = overrides.startedAt ?? new Date("2026-07-30T10:00:00.100Z");
  return {
    id: "00000000-0000-8000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000001",
    receivedAt: new Date("2026-07-30T10:00:00.000Z"),
    traceId: "left-trace",
    spanId: "span",
    eventId: null,
    sourceId: null,
    parentSpanId: null,
    name: "span",
    kind: 1,
    spanClass: "other",
    startedAt,
    endedAt: overrides.endedAt ?? new Date(startedAt.getTime() + 100),
    durationMs: 100,
    statusCode: 1,
    serviceName: null,
    scopeName: null,
    operationName: null,
    providerName: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    costUsd: null,
    searchOrigin: null,
    searchTarget: null,
    searchQuery: null,
    searchTopK: null,
    searchHitCount: null,
    experimentName: null,
    experimentArm: null,
    experimentRole: null,
    experimentAttrs: {},
    attributes: {},
    attrsTruncated: false,
    ...overrides,
  };
}
