import assert from "node:assert/strict";
import { test } from "node:test";
import type { OtelSpan } from "@/lib/ingest/otlp/schema";
import { buildTraceWaterfall, deriveWaterfallPaths } from "./waterfall";

test("buildTraceWaterfall emits a client-safe preorder model over the full span envelope", () => {
  const origin = Date.parse("2026-07-30T10:00:00.000Z");
  const root = span({
    spanId: "0000000000000001",
    name: "root",
    startedAt: new Date(origin + 100),
    endedAt: new Date(origin + 600),
    durationMs: 500,
  });
  const child = span({
    spanId: "0000000000000002",
    parentSpanId: root.spanId,
    name: "child",
    startedAt: new Date(origin + 200),
    endedAt: new Date(origin + 1_000),
    durationMs: 800,
  });
  const orphan = span({
    spanId: "0000000000000003",
    parentSpanId: "ffffffffffffffff",
    name: "orphan",
    startedAt: new Date(origin),
    endedAt: new Date(origin + 100),
    durationMs: 100,
  });

  const view = buildTraceWaterfall([child, root, orphan]);

  assert.deepEqual(
    {
      startedAt: view.startedAt,
      endedAt: view.endedAt,
      durationMs: view.durationMs,
      rows: view.rows.map((row) => ({
        name: row.span.name,
        startedAt: row.span.startedAt,
        depth: row.depth,
        orphaned: row.orphaned,
        offsetRatio: row.offsetRatio,
        durationRatio: row.durationRatio,
      })),
      paths: deriveWaterfallPaths(view.rows),
    },
    {
      startedAt: "2026-07-30T10:00:00.000Z",
      endedAt: "2026-07-30T10:00:01.000Z",
      durationMs: 1_000,
      rows: [
        {
          name: "orphan",
          startedAt: "2026-07-30T10:00:00.000Z",
          depth: 0,
          orphaned: true,
          offsetRatio: 0,
          durationRatio: 0.1,
        },
        {
          name: "root",
          startedAt: "2026-07-30T10:00:00.100Z",
          depth: 0,
          orphaned: false,
          offsetRatio: 0.1,
          durationRatio: 0.5,
        },
        {
          name: "child",
          startedAt: "2026-07-30T10:00:00.200Z",
          depth: 1,
          orphaned: false,
          offsetRatio: 0.2,
          durationRatio: 0.8,
        },
      ],
      paths: [["orphan"], ["root"], ["root", "child"]],
    },
  );
});

test("derived breadcrumbs stay bounded for deeply nested traces and off the wire model", () => {
  const view = buildTraceWaterfall(deepSpanChain(5_000));
  const paths = deriveWaterfallPaths(view.rows);
  const deepestPath = paths.at(-1);

  assert.equal(view.rows.length, 5_000);
  assert.ok(view.rows.every((row) => !("path" in row)));
  assert.ok(paths.every((path) => path.length <= 16));
  assert.deepEqual(deepestPath, [
    "…",
    "span-4985",
    "span-4986",
    "span-4987",
    "span-4988",
    "span-4989",
    "span-4990",
    "span-4991",
    "span-4992",
    "span-4993",
    "span-4994",
    "span-4995",
    "span-4996",
    "span-4997",
    "span-4998",
    "span-4999",
  ]);
});

function deepSpanChain(length: number): OtelSpan[] {
  return Array.from({ length }, (_, index) =>
    span({
      spanId: (index + 1).toString(16).padStart(16, "0"),
      parentSpanId: index === 0 ? null : index.toString(16).padStart(16, "0"),
      name: `span-${index}`,
      startedAt: new Date(1_767_225_600_000 + index),
      endedAt: new Date(1_767_225_600_001 + index),
    }),
  );
}

function span(overrides: Partial<OtelSpan> = {}): OtelSpan {
  const startedAt = new Date("2026-07-30T10:00:00.000Z");
  return {
    id: "00000000-0000-8000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000001",
    receivedAt: new Date("2026-07-30T10:00:00.000Z"),
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    eventId: null,
    sourceId: null,
    parentSpanId: null,
    name: "span",
    kind: 1,
    spanClass: "other",
    startedAt,
    endedAt: new Date(startedAt.getTime() + 1),
    durationMs: 1,
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

test("buildTraceWaterfall returns an explicit empty view for no spans", () => {
  assert.deepEqual(buildTraceWaterfall([]), {
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    rows: [],
  });
});

test("buildTraceWaterfall keeps ratios finite for zero-duration envelopes and bad durations", () => {
  const startedAt = new Date("2026-07-30T10:00:00.000Z");
  const view = buildTraceWaterfall([
    span({
      spanId: "0000000000000001",
      startedAt,
      endedAt: startedAt,
      durationMs: 0,
    }),
    span({
      spanId: "0000000000000002",
      startedAt,
      endedAt: startedAt,
      durationMs: Number.NaN,
    }),
    span({
      spanId: "0000000000000003",
      startedAt,
      endedAt: startedAt,
      durationMs: -5,
    }),
  ]);

  assert.equal(view.durationMs, 0);
  assert.deepEqual(
    view.rows.map((row) => [row.offsetRatio, row.durationRatio]),
    [
      [0, 0],
      [0, 0],
      [0, 0],
    ],
  );
});
