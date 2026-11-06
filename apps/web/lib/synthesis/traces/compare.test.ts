import assert from "node:assert/strict";
import { test } from "node:test";
import type { OtelSpan } from "@/lib/ingest/otlp/schema";
import { compareTraces } from "./compare";

test("compareTraces aligns matching roots independently of span ids", () => {
  const left = span({
    id: "00000000-0000-8000-8000-000000000001",
    traceId: "left-trace",
    spanId: "left-root",
    name: "request",
  });
  const right = span({
    id: "00000000-0000-8000-8000-000000000002",
    traceId: "right-trace",
    spanId: "right-root",
    name: "request",
  });

  assert.deepEqual(compareTraces([left], [right]), [
    {
      path: ["request"],
      occurrence: 0,
      left,
      right,
    },
  ]);
});

test("compareTraces keeps unmatched roots as one-sided rows in name order", () => {
  const left = span({ spanId: "left-zeta", name: "zeta" });
  const right = span({ spanId: "right-alpha", name: "alpha" });

  assert.deepEqual(compareTraces([left], [right]), [
    {
      path: ["alpha"],
      occurrence: 0,
      left: null,
      right,
    },
    {
      path: ["zeta"],
      occurrence: 0,
      left,
      right: null,
    },
  ]);
});

test("compareTraces orders rows independently of which trace is left", () => {
  const leftShared = span({ spanId: "left-shared", name: "shared" });
  const leftOnly = span({ spanId: "left-only", name: "beta" });
  const rightShared = span({ spanId: "right-shared", name: "shared" });
  const rightOnly = span({ spanId: "right-only", name: "alpha" });
  const forward = compareTraces([leftShared, leftOnly], [rightOnly, rightShared]);

  assert.deepEqual(
    compareTraces([rightOnly, rightShared], [leftShared, leftOnly]),
    forward.map(({ path, occurrence, left, right }) => ({
      path,
      occurrence,
      left: right,
      right: left,
    })),
  );
});

test("compareTraces aligns repeated names within their ancestor-name path", () => {
  const leftAgent = span({ spanId: "left-agent", name: "agent" });
  const leftAgentTool = span({
    spanId: "left-agent-tool",
    parentSpanId: leftAgent.spanId,
    name: "tool",
  });
  const leftWorker = span({ spanId: "left-worker", name: "worker" });
  const leftWorkerTool = span({
    spanId: "left-worker-tool",
    parentSpanId: leftWorker.spanId,
    name: "tool",
  });
  const rightAgent = span({ spanId: "right-agent", name: "agent" });
  const rightAgentTool = span({
    spanId: "right-agent-tool",
    parentSpanId: rightAgent.spanId,
    name: "tool",
  });
  const rightWorker = span({ spanId: "right-worker", name: "worker" });

  assert.deepEqual(
    compareTraces(
      [leftWorkerTool, leftAgentTool, leftWorker, leftAgent],
      [rightWorker, rightAgentTool, rightAgent],
    ),
    [
      {
        path: ["agent"],
        occurrence: 0,
        left: leftAgent,
        right: rightAgent,
      },
      {
        path: ["agent", "tool"],
        occurrence: 0,
        left: leftAgentTool,
        right: rightAgentTool,
      },
      {
        path: ["worker"],
        occurrence: 0,
        left: leftWorker,
        right: rightWorker,
      },
      {
        path: ["worker", "tool"],
        occurrence: 0,
        left: leftWorkerTool,
        right: null,
      },
    ],
  );
});

test("compareTraces pairs duplicate siblings by stable occurrence and keeps surplus", () => {
  const leftRoot = span({ spanId: "left-root", name: "request" });
  const leftFirst = span({
    spanId: "left-a",
    parentSpanId: leftRoot.spanId,
    name: "step",
    startedAt: new Date(100),
  });
  const leftSecond = span({
    spanId: "left-z",
    parentSpanId: leftRoot.spanId,
    name: "step",
    startedAt: new Date(100),
  });
  const leftSurplus = span({
    spanId: "left-later",
    parentSpanId: leftRoot.spanId,
    name: "step",
    startedAt: new Date(200),
  });
  const rightRoot = span({ spanId: "right-root", name: "request" });
  const rightFirst = span({
    spanId: "right-a",
    parentSpanId: rightRoot.spanId,
    name: "step",
    startedAt: new Date(100),
  });
  const rightSecond = span({
    spanId: "right-z",
    parentSpanId: rightRoot.spanId,
    name: "step",
    startedAt: new Date(100),
  });

  assert.deepEqual(
    compareTraces(
      [leftSurplus, leftSecond, leftRoot, leftFirst],
      [rightSecond, rightRoot, rightFirst],
    ),
    [
      {
        path: ["request"],
        occurrence: 0,
        left: leftRoot,
        right: rightRoot,
      },
      {
        path: ["request", "step"],
        occurrence: 0,
        left: leftFirst,
        right: rightFirst,
      },
      {
        path: ["request", "step"],
        occurrence: 1,
        left: leftSecond,
        right: rightSecond,
      },
      {
        path: ["request", "step"],
        occurrence: 2,
        left: leftSurplus,
        right: null,
      },
    ],
  );
});

test("compareTraces keeps descendants within their duplicate-parent occurrence", () => {
  const leftRoot = span({ spanId: "left-root", name: "request" });
  const leftFirstBranch = span({
    spanId: "left-a",
    parentSpanId: leftRoot.spanId,
    name: "branch",
  });
  const leftSecondBranch = span({
    spanId: "left-z",
    parentSpanId: leftRoot.spanId,
    name: "branch",
  });
  const leftFirstTask = span({
    spanId: "left-first-task",
    parentSpanId: leftFirstBranch.spanId,
    name: "task",
  });
  const leftSecondTask = span({
    spanId: "left-second-task",
    parentSpanId: leftSecondBranch.spanId,
    name: "task",
  });
  const rightRoot = span({ spanId: "right-root", name: "request" });
  const rightFirstBranch = span({
    spanId: "right-a",
    parentSpanId: rightRoot.spanId,
    name: "branch",
  });
  const rightSecondBranch = span({
    spanId: "right-z",
    parentSpanId: rightRoot.spanId,
    name: "branch",
  });
  const rightFirstTask = span({
    spanId: "right-first-task",
    parentSpanId: rightFirstBranch.spanId,
    name: "task",
  });
  const rightSecondTask = span({
    spanId: "right-second-task",
    parentSpanId: rightSecondBranch.spanId,
    name: "task",
  });

  const taskPairs = compareTraces(
    [leftSecondTask, leftFirstBranch, leftRoot, leftFirstTask, leftSecondBranch],
    [rightSecondBranch, rightFirstTask, rightRoot, rightSecondTask, rightFirstBranch],
  )
    .filter(({ path }) => path.at(-1) === "task")
    .map(({ left, right }) => [left?.spanId, right?.spanId]);

  assert.deepEqual(taskPairs, [
    ["left-first-task", "right-first-task"],
    ["left-second-task", "right-second-task"],
  ]);
});

test("compareTraces keeps structural paths distinct when names contain separators", () => {
  const parent = span({ spanId: "parent", name: "a" });
  const child = span({
    spanId: "child",
    parentSpanId: parent.spanId,
    name: "b",
  });
  const separatorName = span({
    spanId: "separator-name",
    name: "a#0\0b",
  });

  assert.deepEqual(compareTraces([separatorName, child, parent], []), [
    {
      path: ["a"],
      occurrence: 0,
      left: parent,
      right: null,
    },
    {
      path: ["a", "b"],
      occurrence: 0,
      left: child,
      right: null,
    },
    {
      path: ["a#0\0b"],
      occurrence: 0,
      left: separatorName,
      right: null,
    },
  ]);
});

test("compareTraces promotes orphans and breaks cycles without dropping spans", () => {
  const cycleRoot = span({
    spanId: "cycle-a",
    parentSpanId: "cycle-b",
    name: "alpha",
  });
  const cycleChild = span({
    spanId: "cycle-b",
    parentSpanId: "cycle-a",
    name: "beta",
  });
  const orphan = span({
    spanId: "orphan",
    parentSpanId: "pruned-parent",
    name: "orphan",
  });

  assert.deepEqual(compareTraces([cycleChild, orphan, cycleRoot], []), [
    {
      path: ["alpha"],
      occurrence: 0,
      left: cycleRoot,
      right: null,
    },
    {
      path: ["alpha", "beta"],
      occurrence: 0,
      left: cycleChild,
      right: null,
    },
    {
      path: ["orphan"],
      occurrence: 0,
      left: orphan,
      right: null,
    },
  ]);
});

test("compareTraces does not mutate either input", () => {
  const leftRoot = span({ spanId: "left-root", name: "root" });
  const leftChild = span({
    spanId: "left-child",
    parentSpanId: leftRoot.spanId,
    name: "child",
  });
  const right = span({ spanId: "right-root", name: "root" });
  const leftSpans = Object.freeze([leftChild, leftRoot]);
  const rightSpans = Object.freeze([right]);
  const before = structuredClone([leftSpans, rightSpans]);

  compareTraces(leftSpans, rightSpans);

  assert.deepEqual([leftSpans, rightSpans], before);
});

test("compareTraces handles a 5000-span-deep trace without overflowing the call stack", () => {
  const comparison = compareTraces(deepSpanChain(5_000), []);

  assert.equal(comparison.length, 5_000);
  assert.equal(comparison[0].path.length, 1);
  assert.equal(comparison.at(-1)?.path.length, 5_000);
  assert.equal(comparison.at(-1)?.left?.spanId, deepSpanId(4_999));
});

function deepSpanChain(length: number): OtelSpan[] {
  return Array.from({ length }, (_, index) =>
    span({
      spanId: deepSpanId(index),
      parentSpanId: index === 0 ? null : deepSpanId(index - 1),
      name: "span",
      startedAt: new Date(index),
    }),
  );
}

function deepSpanId(index: number): string {
  return (index + 1).toString(16).padStart(16, "0");
}

function span(overrides: Partial<OtelSpan> = {}): OtelSpan {
  const startedAt = new Date("2026-01-01T00:00:00.000Z");

  return {
    id: "00000000-0000-8000-8000-000000000000",
    projectId: "00000000-0000-4000-8000-000000000000",
    receivedAt: new Date("2026-01-01T00:00:00.000Z"),
    traceId: "trace",
    spanId: "span",
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
