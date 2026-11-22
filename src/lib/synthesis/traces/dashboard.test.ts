import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTraceDashboardModel } from "./dashboard";
import type { TraceDailyAggregate, TraceKpis } from "./queries";

const DAYS = ["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30"];

test("buildTraceDashboardModel densifies sparse days and builds trace vitals", () => {
  const model = buildTraceDashboardModel(
    traceKpis(),
    [
      day({
        day: DAYS[0],
        traceCount: 2,
        errorTraceCount: 1,
        averageLatencyMs: 100,
        totalTokens: 10,
      }),
      day({
        day: DAYS[2],
        traceCount: 4,
        averageLatencyMs: 200,
        totalTokens: 20,
      }),
      day({
        day: DAYS[3],
        traceCount: 6,
        errorTraceCount: 3,
        averageLatencyMs: 300,
        totalTokens: 30,
      }),
    ],
    DAYS,
    new Date("2026-07-31T00:00:00.000Z"),
  );

  assert.deepEqual(
    model.days.map(
      ({
        day,
        traceCount,
        cleanTraceCount,
        errorTraceCount,
        errorRate,
        averageLatencyMs,
        totalTokens,
      }) => ({
        day,
        traceCount,
        cleanTraceCount,
        errorTraceCount,
        errorRate,
        averageLatencyMs,
        totalTokens,
      }),
    ),
    [
      {
        day: DAYS[0],
        traceCount: 2,
        cleanTraceCount: 1,
        errorTraceCount: 1,
        errorRate: 0.5,
        averageLatencyMs: 100,
        totalTokens: 10,
      },
      {
        day: DAYS[1],
        traceCount: 0,
        cleanTraceCount: 0,
        errorTraceCount: 0,
        errorRate: 0,
        averageLatencyMs: 0,
        totalTokens: 0,
      },
      {
        day: DAYS[2],
        traceCount: 4,
        cleanTraceCount: 4,
        errorTraceCount: 0,
        errorRate: 0,
        averageLatencyMs: 200,
        totalTokens: 20,
      },
      {
        day: DAYS[3],
        traceCount: 6,
        cleanTraceCount: 3,
        errorTraceCount: 3,
        errorRate: 0.5,
        averageLatencyMs: 300,
        totalTokens: 30,
      },
    ],
  );
  assert.deepEqual(
    model.kpis.map(({ key, value, sub, series, delta, upIsGood }) => ({
      key,
      value,
      sub,
      series,
      delta,
      upIsGood,
    })),
    [
      {
        key: "traces",
        value: "12",
        sub: "8 clean",
        series: [2, 0, 4, 6],
        delta: { pct: 4, dir: "up" },
        upIsGood: true,
      },
      {
        key: "errors",
        value: "33%",
        sub: "4 affected traces",
        series: [0.5, 0, 0, 0.5],
        delta: { pct: -0.4, dir: "down" },
        upIsGood: false,
      },
      {
        key: "latency",
        value: "240ms",
        sub: "p95 470ms",
        series: [100, 0, 200, 300],
        delta: { pct: 1.6, dir: "up" },
        upIsGood: false,
      },
      {
        key: "tokens",
        value: "60",
        sub: "45 in · 15 out",
        series: [10, 0, 20, 30],
        delta: { pct: 4, dir: "up" },
        upIsGood: false,
      },
    ],
  );
});

test("buildTraceDashboardModel buckets long ranges without losing volume", () => {
  const windowDays = Array.from({ length: 61 }, (_, index) =>
    new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10),
  );
  const aggregates = windowDays.map((value, index) =>
    day({
      day: value,
      traceCount: 1,
      errorTraceCount: index % 3 === 0 ? 1 : 0,
      averageLatencyMs: index + 1,
      totalTokens: 2,
      costUsd: 0.01,
    }),
  );

  const model = buildTraceDashboardModel(
    traceKpis({
      traceCount: 61,
      errorTraceCount: 21,
      totalTokens: 122,
    }),
    aggregates,
    windowDays,
    new Date("2026-08-01T00:00:00.000Z"),
  );

  assert.equal(model.buckets.length, 31);
  assert.deepEqual(model.buckets[0], {
    fromDay: "2026-06-01",
    toDay: "2026-06-02",
    label: "Jun 2",
    rangeLabel: "Jun 1 – Jun 2",
    traceCount: 2,
    cleanTraceCount: 1,
    errorTraceCount: 1,
    averageLatencyMs: 1.5,
    totalTokens: 4,
    costUsd: 0.02,
  });
  assert.deepEqual(model.buckets.at(-1), {
    fromDay: "2026-07-31",
    toDay: "2026-07-31",
    label: "Jul 31",
    rangeLabel: "Jul 31",
    traceCount: 1,
    cleanTraceCount: 0,
    errorTraceCount: 1,
    averageLatencyMs: 61,
    totalTokens: 2,
    costUsd: 0.01,
  });
  assert.deepEqual(
    model.buckets.reduce(
      (totals, bucket) => ({
        traces: totals.traces + bucket.traceCount,
        clean: totals.clean + bucket.cleanTraceCount,
        errors: totals.errors + bucket.errorTraceCount,
        tokens: totals.tokens + bucket.totalTokens,
      }),
      { traces: 0, clean: 0, errors: 0, tokens: 0 },
    ),
    { traces: 61, clean: 40, errors: 21, tokens: 122 },
  );
});

test("buildTraceDashboardModel excludes the partial current UTC day from deltas", () => {
  const windowDays = [
    "2026-07-26",
    "2026-07-27",
    "2026-07-28",
    "2026-07-29",
    "2026-07-30",
    "2026-07-31",
  ];
  const traceCounts = [10, 10, 20, 20, 1, 0];
  const model = buildTraceDashboardModel(
    traceKpis({ traceCount: 61 }),
    windowDays.map((value, index) =>
      day({
        day: value,
        traceCount: traceCounts[index],
      }),
    ),
    windowDays,
    new Date("2026-07-30T08:00:00.000Z"),
  );
  const traces = model.kpis.find(({ key }) => key === "traces");

  assert.deepEqual(
    { series: traces?.series, delta: traces?.delta },
    {
      series: traceCounts,
      delta: { pct: 1, dir: "up" },
    },
  );
});

function traceKpis(overrides: Partial<TraceKpis> = {}): TraceKpis {
  return {
    traceCount: 12,
    errorTraceCount: 4,
    errorRate: 1 / 3,
    averageLatencyMs: 240,
    p50LatencyMs: 180,
    p95LatencyMs: 470,
    inputTokens: 45,
    outputTokens: 15,
    totalTokens: 60,
    costUsd: 0.03,
    ...overrides,
  };
}

function day(
  overrides: Partial<TraceDailyAggregate> & Pick<TraceDailyAggregate, "day">,
): TraceDailyAggregate {
  return {
    traceCount: 0,
    errorTraceCount: 0,
    averageLatencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    ...overrides,
  };
}
