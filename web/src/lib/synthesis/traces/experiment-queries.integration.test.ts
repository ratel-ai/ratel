import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { RATEL, RATEL_EXPERIMENT, RATEL_SEARCH } from "@/lib/ingest/otlp/constants";
import { deriveRatelSearches } from "@/lib/ingest/otlp/derive-search";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import { toOtelSpanRows } from "@/lib/ingest/otlp/span-rows";
import type { DecodedSpan } from "@/lib/ingest/otlp/types";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { createExperimentService } from "@/lib/synthesis/experiments/service";
import {
  countMultiArmTraces,
  createExperimentQueries,
  type ExperimentQueriesDb,
  getArmMetricAggregates,
  listArmSearchSpans,
  listExperimentArmAggregates,
  listExperimentDetectionAggregates,
} from "./experiment-queries";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const WINDOW = {
  since: new Date("2026-07-30T00:00:00.000Z"),
  until: new Date("2026-07-31T00:00:00.000Z"),
};

type TestDb = ExperimentQueriesDb & NonNullable<Parameters<typeof insertOtelSpans>[2]>;

test("listExperimentArmAggregates counts traces once per arm within project and window", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(1),
        traceId: traceId(1),
        spanId: spanId(1),
        experimentName: "checkout",
        experimentArm: "control",
        startedAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
      span({
        id: uuid(2),
        traceId: traceId(1),
        spanId: spanId(2),
        parentSpanId: spanId(1),
        experimentName: "checkout",
        experimentArm: "control",
        startedAt: new Date("2026-07-30T10:00:00.100Z"),
      }),
      span({
        id: uuid(3),
        traceId: traceId(2),
        spanId: spanId(3),
        experimentName: "checkout",
        experimentArm: "control",
        startedAt: new Date("2026-07-30T12:00:00.000Z"),
      }),
      span({
        id: uuid(4),
        traceId: traceId(3),
        spanId: spanId(4),
        experimentName: "checkout",
        experimentArm: "variant",
        startedAt: new Date("2026-07-30T11:00:00.000Z"),
      }),
      span({
        id: uuid(5),
        traceId: traceId(4),
        spanId: spanId(5),
        experimentName: "checkout",
        experimentArm: "control",
        startedAt: new Date("2026-07-29T23:59:59.999Z"),
      }),
      experimentSpan(7, "   ", "control", traceId(6)),
      experimentSpan(8, "checkout", "   ", traceId(7)),
    ],
    db,
  );
  await insertOtelSpans(
    OTHER_PROJECT_ID,
    [
      span({
        id: uuid(6),
        projectId: OTHER_PROJECT_ID,
        traceId: traceId(5),
        spanId: spanId(6),
        experimentName: "checkout",
        experimentArm: "control",
        startedAt: new Date("2026-07-30T13:00:00.000Z"),
      }),
    ],
    db,
  );

  const aggregates = await listExperimentArmAggregates(PROJECT_ID, WINDOW, db);

  assert.deepEqual(aggregates, [
    {
      experimentName: "checkout",
      arm: "control",
      traceCount: 2,
      experimentTraceCount: 3,
      firstSeenAt: new Date("2026-07-30T10:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T12:00:00.000Z"),
    },
    {
      experimentName: "checkout",
      arm: "variant",
      traceCount: 1,
      experimentTraceCount: 3,
      firstSeenAt: new Date("2026-07-30T11:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T11:00:00.000Z"),
    },
  ]);
  await client.close();
});

test("listExperimentArmAggregates scopes whole traces by root and reports arm span bounds", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(7),
        traceId: traceId(6),
        spanId: spanId(7),
        startedAt: new Date("2026-07-29T23:59:59.999Z"),
      }),
      experimentSpan(8, "boundary", "control", traceId(6), {
        parentSpanId: spanId(7),
        startedAt: new Date("2026-07-30T00:00:00.001Z"),
      }),
      span({
        id: uuid(9),
        traceId: traceId(7),
        spanId: spanId(9),
        startedAt: new Date("2026-07-30T23:59:59.999Z"),
      }),
      experimentSpan(10, "boundary", "variant", traceId(7), {
        parentSpanId: spanId(9),
        startedAt: new Date("2026-07-31T00:00:00.001Z"),
      }),
    ],
    db,
  );

  assert.deepEqual(await listExperimentArmAggregates(PROJECT_ID, WINDOW, db), [
    {
      experimentName: "boundary",
      arm: "variant",
      traceCount: 1,
      experimentTraceCount: 1,
      firstSeenAt: new Date("2026-07-31T00:00:00.001Z"),
      lastSeenAt: new Date("2026-07-31T00:00:00.001Z"),
    },
  ]);
  await client.close();
});

test("listExperimentArmAggregates uses the earliest surviving span for rootless traces", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(84),
        traceId: traceId(18),
        spanId: spanId(84),
        parentSpanId: spanId(999),
        startedAt: new Date("2026-07-30T08:00:00.000Z"),
      }),
      experimentSpan(85, "rootless", "control", traceId(18), {
        parentSpanId: spanId(84),
        startedAt: new Date("2026-07-30T08:00:00.100Z"),
      }),
      span({
        id: uuid(86),
        traceId: traceId(19),
        spanId: spanId(86),
        parentSpanId: spanId(998),
        startedAt: new Date("2026-07-29T23:59:59.999Z"),
      }),
      experimentSpan(87, "rootless", "variant", traceId(19), {
        parentSpanId: spanId(86),
        startedAt: new Date("2026-07-30T08:00:00.100Z"),
      }),
    ],
    db,
  );

  assert.deepEqual(await listExperimentArmAggregates(PROJECT_ID, WINDOW, db), [
    {
      experimentName: "rootless",
      arm: "control",
      traceCount: 1,
      experimentTraceCount: 1,
      firstSeenAt: new Date("2026-07-30T08:00:00.100Z"),
      lastSeenAt: new Date("2026-07-30T08:00:00.100Z"),
    },
  ]);
  await client.close();
});

test("listExperimentArmAggregates excludes multi-root traces whose earliest root is out of window", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      // Earliest root sits before the window, so the canonical representative is
      // out of window and the whole trace must be excluded — even though a later
      // in-window root carries an in-window experiment tag. Guards against
      // accidentally adopting listTraces' earliest-in-window-root semantics.
      span({
        id: uuid(100),
        traceId: traceId(100),
        spanId: spanId(100),
        startedAt: new Date("2026-07-29T23:00:00.000Z"),
      }),
      span({
        id: uuid(101),
        traceId: traceId(100),
        spanId: spanId(101),
        startedAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
      experimentSpan(102, "straddle-out", "control", traceId(100), {
        parentSpanId: spanId(101),
        startedAt: new Date("2026-07-30T10:00:00.100Z"),
      }),
    ],
    db,
  );

  assert.deepEqual(await listExperimentArmAggregates(PROJECT_ID, WINDOW, db), []);
  await client.close();
});

test("listExperimentArmAggregates includes multi-root traces by their earliest root and orders search spans by it", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      // Trace P: earliest root (02:00) is in window and is the representative,
      // even though a later root (20:00) also exists.
      span({
        id: uuid(110),
        traceId: traceId(110),
        spanId: spanId(110),
        startedAt: new Date("2026-07-30T02:00:00.000Z"),
      }),
      span({
        id: uuid(111),
        traceId: traceId(110),
        spanId: spanId(111),
        startedAt: new Date("2026-07-30T20:00:00.000Z"),
      }),
      experimentSpan(112, "straddle-in", "control", traceId(110), {
        parentSpanId: spanId(110),
        spanClass: "ratel_search",
        startedAt: new Date("2026-07-30T09:00:00.000Z"),
        searchHitCount: 1,
      }),
      // Trace Q: single root at 10:00, so its representative starts after P's.
      span({
        id: uuid(113),
        traceId: traceId(111),
        spanId: spanId(113),
        startedAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
      experimentSpan(114, "straddle-in", "control", traceId(111), {
        parentSpanId: spanId(113),
        spanClass: "ratel_search",
        startedAt: new Date("2026-07-30T11:00:00.000Z"),
        searchHitCount: 2,
      }),
    ],
    db,
  );

  assert.deepEqual(await listExperimentArmAggregates(PROJECT_ID, WINDOW, db), [
    {
      experimentName: "straddle-in",
      arm: "control",
      traceCount: 2,
      experimentTraceCount: 2,
      firstSeenAt: new Date("2026-07-30T09:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T11:00:00.000Z"),
    },
  ]);
  // listArmSearchSpans orders by the representative's own startedAt, so P
  // (rep 02:00) must precede Q (rep 10:00). Picking P's later root would flip it.
  assert.deepEqual(
    (await listArmSearchSpans(PROJECT_ID, "straddle-in", WINDOW, db)).map(
      ({ traceId: id, arm }) => ({ traceId: id, arm }),
    ),
    [
      { traceId: traceId(110), arm: "control" },
      { traceId: traceId(111), arm: "control" },
    ],
  );
  await client.close();
});

test("listExperimentArmAggregates resolves wide single-root traces from one representative", async () => {
  const { client, db } = await setup();
  const rootStartedAt = new Date("2026-07-30T10:00:00.000Z");
  // Tag (and the rest of the trace) sit after the window; only the root is in
  // window, and the whole-trace re-join still counts the out-of-window tag.
  const tagStartedAt = new Date("2026-07-31T05:00:00.000Z");
  const spans: NewOtelSpan[] = [
    span({
      id: uuid(200),
      traceId: traceId(200),
      spanId: spanId(200),
      startedAt: rootStartedAt,
    }),
  ];
  for (let i = 1; i < 50; i += 1) {
    spans.push(
      span({
        id: uuid(200 + i),
        traceId: traceId(200),
        spanId: spanId(200 + i),
        parentSpanId: spanId(200),
        startedAt: new Date(tagStartedAt.getTime() + i),
      }),
    );
  }
  spans.push(
    experimentSpan(300, "wide", "control", traceId(200), {
      parentSpanId: spanId(200),
      startedAt: tagStartedAt,
    }),
  );
  await insertOtelSpans(PROJECT_ID, spans, db);

  assert.deepEqual(await listExperimentArmAggregates(PROJECT_ID, WINDOW, db), [
    {
      experimentName: "wide",
      arm: "control",
      traceCount: 1,
      experimentTraceCount: 1,
      firstSeenAt: tagStartedAt,
      lastSeenAt: tagStartedAt,
    },
  ]);
  await client.close();
});

test("countMultiArmTraces distinguishes shadow traces from split traces", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      experimentSpan(10, "split", "control", traceId(10)),
      experimentSpan(11, "split", "variant", traceId(11)),
      experimentSpan(12, "shadow", "control", traceId(12)),
      experimentSpan(13, "shadow", "variant", traceId(12)),
      experimentSpan(14, "shadow", "control", traceId(12), {
        parentSpanId: spanId(12),
      }),
      experimentSpan(15, "shadow", "control", traceId(13)),
      experimentSpan(16, "mixed", "control", traceId(14)),
      experimentSpan(17, "mixed", "variant", traceId(14)),
      experimentSpan(18, "mixed", "control", traceId(15)),
    ],
    db,
  );

  assert.deepEqual(await countMultiArmTraces(PROJECT_ID, WINDOW, db), [
    { experimentName: "mixed", traceCount: 1 },
    { experimentName: "shadow", traceCount: 1 },
  ]);
  await client.close();
});

test("countMultiArmTraces applies the window to the trace root", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      span({
        id: uuid(19),
        traceId: traceId(16),
        spanId: spanId(19),
        startedAt: new Date("2026-07-29T23:59:59.999Z"),
      }),
      experimentSpan(20, "outside-shadow", "control", traceId(16), {
        parentSpanId: spanId(19),
        startedAt: new Date("2026-07-30T00:00:00.001Z"),
      }),
      experimentSpan(21, "outside-shadow", "variant", traceId(16), {
        parentSpanId: spanId(19),
        startedAt: new Date("2026-07-30T00:00:00.002Z"),
      }),
      span({
        id: uuid(22),
        traceId: traceId(17),
        spanId: spanId(22),
        startedAt: new Date("2026-07-30T23:59:59.999Z"),
      }),
      experimentSpan(23, "inside-shadow", "control", traceId(17), {
        parentSpanId: spanId(22),
        startedAt: new Date("2026-07-31T00:00:00.001Z"),
      }),
      experimentSpan(24, "inside-shadow", "variant", traceId(17), {
        parentSpanId: spanId(22),
        startedAt: new Date("2026-07-31T00:00:00.002Z"),
      }),
    ],
    db,
  );

  assert.deepEqual(await countMultiArmTraces(PROJECT_ID, WINDOW, db), [
    { experimentName: "inside-shadow", traceCount: 1 },
  ]);
  await client.close();
});

test("listExperimentDetectionAggregates folds arm and multi-arm rollups from one scan", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      experimentSpan(300, "combo", "control", traceId(300), {
        startedAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
      experimentSpan(301, "combo", "control", traceId(301), {
        startedAt: new Date("2026-07-30T10:30:00.000Z"),
      }),
      // Same trace, second arm => a multi-arm (shadow) trace for "combo".
      experimentSpan(302, "combo", "variant", traceId(301), {
        startedAt: new Date("2026-07-30T10:45:00.000Z"),
      }),
      experimentSpan(303, "combo", "variant", traceId(302), {
        startedAt: new Date("2026-07-30T11:00:00.000Z"),
      }),
      experimentSpan(304, "solo", "a", traceId(303), {
        startedAt: new Date("2026-07-30T09:00:00.000Z"),
      }),
    ],
    db,
  );

  const combined = await listExperimentDetectionAggregates(PROJECT_ID, WINDOW, db);

  // The two public wrappers are exactly the two halves of this one scan.
  assert.deepEqual(
    combined.armAggregates,
    await listExperimentArmAggregates(PROJECT_ID, WINDOW, db),
  );
  assert.deepEqual(combined.multiArmCounts, await countMultiArmTraces(PROJECT_ID, WINDOW, db));

  assert.deepEqual(combined.armAggregates, [
    {
      experimentName: "combo",
      arm: "control",
      traceCount: 2,
      experimentTraceCount: 3,
      firstSeenAt: new Date("2026-07-30T10:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T10:30:00.000Z"),
    },
    {
      experimentName: "combo",
      arm: "variant",
      traceCount: 2,
      experimentTraceCount: 3,
      firstSeenAt: new Date("2026-07-30T10:45:00.000Z"),
      lastSeenAt: new Date("2026-07-30T11:00:00.000Z"),
    },
    {
      experimentName: "solo",
      arm: "a",
      traceCount: 1,
      experimentTraceCount: 1,
      firstSeenAt: new Date("2026-07-30T09:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T09:00:00.000Z"),
    },
  ]);
  assert.deepEqual(combined.multiArmCounts, [{ experimentName: "combo", traceCount: 1 }]);
  await client.close();
});

test("getArmMetricAggregates computes trace-level arm metrics", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      experimentSpan(30, "metrics", "control", traceId(30), {
        durationMs: 1_000,
      }),
      experimentSpan(31, "metrics", "control", traceId(30), {
        parentSpanId: spanId(30),
        spanClass: "llm_call",
        durationMs: 9_000,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: "0.100000",
      }),
      experimentSpan(32, "metrics", "control", traceId(30), {
        parentSpanId: spanId(30),
        spanClass: "ratel_search",
        searchHitCount: 4,
      }),
      experimentSpan(33, "metrics", "control", traceId(31), {
        durationMs: 3_000,
      }),
      experimentSpan(34, "metrics", "control", traceId(31), {
        parentSpanId: spanId(33),
        spanClass: "llm_call",
        inputTokens: 300,
        outputTokens: 150,
        costUsd: "0.300000",
      }),
      experimentSpan(35, "metrics", "control", traceId(31), {
        parentSpanId: spanId(33),
        spanClass: "ratel_search",
        searchHitCount: 2,
      }),
      experimentSpan(36, "metrics", "control", traceId(31), {
        parentSpanId: spanId(33),
        spanClass: "tool",
        statusCode: 2,
      }),
      experimentSpan(37, "metrics", "variant", traceId(32), {
        durationMs: 2_000,
      }),
      experimentSpan(38, "metrics", "variant", traceId(32), {
        parentSpanId: spanId(37),
        spanClass: "llm_call",
        inputTokens: 200,
        outputTokens: 100,
        costUsd: "0.200000",
      }),
      experimentSpan(39, "metrics", "variant", traceId(32), {
        parentSpanId: spanId(37),
        spanClass: "ratel_search",
        searchHitCount: 6,
      }),
      experimentSpan(40, "metrics", "control", traceId(33), {
        durationMs: 99_000,
        startedAt: WINDOW.until,
      }),
    ],
    db,
  );
  await insertOtelSpans(
    OTHER_PROJECT_ID,
    [
      experimentSpan(41, "metrics", "control", traceId(34), {
        id: uuid(41),
        projectId: OTHER_PROJECT_ID,
        durationMs: 88_000,
      }),
    ],
    db,
  );

  assert.deepEqual(await getArmMetricAggregates(PROJECT_ID, "metrics", WINDOW, db), [
    {
      arm: "control",
      traceCount: 2,
      errorTraceCount: 1,
      averageLatencyMs: 2_000,
      p50LatencyMs: 2_000,
      p95LatencyMs: 2_900,
      averageInputTokens: 200,
      averageOutputTokens: 100,
      averageCostUsd: 0.2,
      averageSearchCount: 1,
      averageSearchHitCount: 3,
    },
    {
      arm: "variant",
      traceCount: 1,
      errorTraceCount: 0,
      averageLatencyMs: 2_000,
      p50LatencyMs: 2_000,
      p95LatencyMs: 2_000,
      averageInputTokens: 200,
      averageOutputTokens: 100,
      averageCostUsd: 0.2,
      averageSearchCount: 1,
      averageSearchHitCount: 6,
    },
  ]);
  await client.close();
});

test("listArmSearchSpans hydrates rankings through derived trace-event ids", async () => {
  const { client, db } = await setup();
  await insertRankingFixture(db);

  assert.deepEqual(await listArmSearchSpans(PROJECT_ID, "rankings", WINDOW, db), [
    {
      arm: "control",
      traceId: traceId(40),
      spanId: spanId(40),
      reportedHitCount: 5,
      hits: [
        { type: "skill", id: "alpha", rank: 0, score: null },
        { type: "skill", id: "control-only", rank: 1, score: null },
        { type: "skill", id: "beta", rank: 2, score: null },
        { type: "skill", id: "gamma", rank: 3, score: null },
        { type: "skill", id: "delta", rank: 4, score: null },
      ],
    },
    {
      arm: "variant",
      traceId: traceId(41),
      spanId: spanId(41),
      reportedHitCount: 4,
      hits: [
        { type: "skill", id: "beta", rank: 0, score: null },
        { type: "skill", id: "gamma", rank: 1, score: null },
        { type: "skill", id: "delta", rank: 2, score: null },
        { type: "skill", id: "alpha", rank: 3, score: null },
      ],
    },
  ]);
  await client.close();
});

test("experiment service detects split and shadow runs from persisted spans", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      experimentSpan(50, "split-checkout", "control", traceId(50), {
        startedAt: new Date("2026-07-30T09:00:00.000Z"),
      }),
      experimentSpan(51, "split-checkout", "variant", traceId(51), {
        startedAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
      experimentSpan(52, "shadow-checkout", "control", traceId(52), {
        startedAt: new Date("2026-07-30T11:00:00.000Z"),
      }),
      experimentSpan(53, "shadow-checkout", "variant", traceId(52), {
        startedAt: new Date("2026-07-30T11:00:00.100Z"),
      }),
    ],
    db,
  );
  const service = createExperimentService(createExperimentQueries(db));

  assert.deepEqual(await service.listExperiments(PROJECT_ID, WINDOW), [
    {
      name: "shadow-checkout",
      mode: "shadow",
      baselineArm: "control",
      traceCount: 1,
      multiArmTraceCount: 1,
      arms: [
        { arm: "control", traceCount: 1, traceShare: 1 },
        { arm: "variant", traceCount: 1, traceShare: 1 },
      ],
      firstSeenAt: new Date("2026-07-30T11:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T11:00:00.100Z"),
    },
    {
      name: "split-checkout",
      mode: "split",
      baselineArm: "control",
      traceCount: 2,
      multiArmTraceCount: 0,
      arms: [
        { arm: "control", traceCount: 1, traceShare: 0.5 },
        { arm: "variant", traceCount: 1, traceShare: 0.5 },
      ],
      firstSeenAt: new Date("2026-07-30T09:00:00.000Z"),
      lastSeenAt: new Date("2026-07-30T10:00:00.000Z"),
    },
  ]);
  await client.close();
});

test("experiment service compares persisted arm metrics and capability ranks", async () => {
  const { client, db } = await setup();
  await insertRankingFixture(db);
  const service = createExperimentService(createExperimentQueries(db));

  const comparison = await service.getExperimentComparison(PROJECT_ID, "rankings", WINDOW);

  assert.equal(comparison?.name, "rankings");
  assert.equal(comparison?.mode, "split");
  assert.equal(comparison?.baselineArm, "control");
  assert.deepEqual(
    comparison?.arms.map(({ arm, metrics, deltas }) => ({
      arm,
      traceCount: metrics.traceCount,
      averageLatencyMs: metrics.averageLatencyMs,
      averageSearchHitCount: metrics.averageSearchHitCount,
      searchHitDelta: deltas?.averageSearchHitCount ?? null,
    })),
    [
      {
        arm: "control",
        traceCount: 1,
        averageLatencyMs: 100,
        averageSearchHitCount: 5,
        searchHitDelta: null,
      },
      {
        arm: "variant",
        traceCount: 1,
        averageLatencyMs: 100,
        averageSearchHitCount: 4,
        searchHitDelta: { absolute: -1, relative: -0.2 },
      },
    ],
  );
  assert.equal(comparison?.capabilities.hasRankings, true);
  assert.deepEqual(
    comparison?.capabilities.rows
      .filter(({ id }) => id === "alpha" || id === "control-only")
      .map(({ id, arms }) => ({ id, arms })),
    [
      {
        id: "alpha",
        arms: [
          {
            arm: "control",
            appearances: 1,
            averageRank: 0,
            rankDelta: 0,
            absent: false,
          },
          {
            arm: "variant",
            appearances: 1,
            averageRank: 3,
            rankDelta: 3,
            absent: false,
          },
        ],
      },
      {
        id: "control-only",
        arms: [
          {
            arm: "control",
            appearances: 1,
            averageRank: 1,
            rankDelta: 0,
            absent: false,
          },
          {
            arm: "variant",
            appearances: 0,
            averageRank: null,
            rankDelta: null,
            absent: true,
          },
        ],
      },
    ],
  );
  await client.close();
});

test("experiment service compares shadow arms within one trace", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      experimentSpan(60, "shadow-metrics", "control", traceId(60), {
        durationMs: 100,
      }),
      experimentSpan(61, "shadow-metrics", "control", traceId(60), {
        parentSpanId: spanId(60),
        spanClass: "llm_call",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: "0.100000",
      }),
      experimentSpan(62, "shadow-metrics", "variant", traceId(60), {
        durationMs: 150,
      }),
      experimentSpan(63, "shadow-metrics", "variant", traceId(60), {
        parentSpanId: spanId(62),
        spanClass: "llm_call",
        inputTokens: 200,
        outputTokens: 100,
        costUsd: "0.200000",
      }),
    ],
    db,
  );
  const service = createExperimentService(createExperimentQueries(db));

  const comparison = await service.getExperimentComparison(PROJECT_ID, "shadow-metrics", WINDOW);

  assert.deepEqual(
    {
      mode: comparison?.mode,
      baselineArm: comparison?.baselineArm,
      arms: comparison?.arms.map(({ arm, metrics, deltas }) => ({
        arm,
        traceCount: metrics.traceCount,
        averageLatencyMs: metrics.averageLatencyMs,
        averageInputTokens: metrics.averageInputTokens,
        latencyDelta: deltas?.averageLatencyMs ?? null,
      })),
    },
    {
      mode: "shadow",
      baselineArm: "control",
      arms: [
        {
          arm: "control",
          traceCount: 1,
          averageLatencyMs: 100,
          averageInputTokens: 100,
          latencyDelta: null,
        },
        {
          arm: "variant",
          traceCount: 1,
          averageLatencyMs: 150,
          averageInputTokens: 200,
          latencyDelta: { absolute: 50, relative: 0.5 },
        },
      ],
    },
  );
  await client.close();
});

test("experiment service preserves unknown search hit counts", async () => {
  const { client, db } = await setup();
  await insertOtelSpans(
    PROJECT_ID,
    [
      experimentSpan(70, "unknown-hits", "control", traceId(70)),
      experimentSpan(71, "unknown-hits", "control", traceId(70), {
        parentSpanId: spanId(70),
        spanClass: "ratel_search",
        searchHitCount: 2,
      }),
      experimentSpan(72, "unknown-hits", "variant", traceId(71)),
      experimentSpan(73, "unknown-hits", "variant", traceId(71), {
        parentSpanId: spanId(72),
        spanClass: "ratel_search",
        searchHitCount: null,
      }),
    ],
    db,
  );
  const service = createExperimentService(createExperimentQueries(db));

  const comparison = await service.getExperimentComparison(PROJECT_ID, "unknown-hits", WINDOW);

  assert.deepEqual(
    comparison?.arms.map(({ arm, metrics, deltas }) => ({
      arm,
      averageSearchHitCount: metrics.averageSearchHitCount,
      searchHitDelta: deltas?.averageSearchHitCount ?? null,
    })),
    [
      {
        arm: "control",
        averageSearchHitCount: 2,
        searchHitDelta: null,
      },
      {
        arm: "variant",
        averageSearchHitCount: null,
        searchHitDelta: null,
      },
    ],
  );
  assert.deepEqual(comparison?.capabilities.reportedHitMetrics, [
    {
      arm: "control",
      total: 2,
      searchSpanCount: 1,
      averagePerSearch: 2,
    },
    {
      arm: "variant",
      total: null,
      searchSpanCount: 1,
      averagePerSearch: null,
    },
  ]);
  await client.close();
});

async function setup(): Promise<{ client: PGlite; db: TestDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug)
    values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values
      ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent'),
      ('${OTHER_PROJECT_ID}', '${ORGANIZATION_ID}', 'Other', 'other');
  `);
  return {
    client,
    db: drizzle(client, { schema }) as unknown as TestDb,
  };
}

async function insertRankingFixture(db: TestDb): Promise<void> {
  const decodedSpans = [
    decodedSearchSpan(40, 40, "control", 5),
    decodedSearchSpan(41, 41, "variant", 4),
  ];
  await insertOtelSpans(PROJECT_ID, toOtelSpanRows(PROJECT_ID, decodedSpans), db);
  const derivedEvents = deriveRatelSearches(decodedSpans);
  await insertTraceEvents(
    PROJECT_ID,
    [
      {
        ...derivedEvents[0],
        hits: [
          traceEventHit("alpha", 0),
          traceEventHit("control-only", 1),
          traceEventHit("beta", 2),
          traceEventHit("gamma", 3),
          traceEventHit("delta", 4),
        ],
      },
      {
        ...derivedEvents[1],
        hits: [
          traceEventHit("beta", 0),
          traceEventHit("gamma", 1),
          traceEventHit("delta", 2),
          traceEventHit("alpha", 3),
        ],
      },
    ],
    db,
  );
}

function span(overrides: Partial<NewOtelSpan> = {}): NewOtelSpan {
  const startedAt = overrides.startedAt ?? new Date("2026-07-30T10:00:00.000Z");
  return {
    id: uuid(1),
    projectId: PROJECT_ID,
    traceId: traceId(1),
    spanId: spanId(1),
    parentSpanId: null,
    name: "agent.run",
    kind: 1,
    spanClass: "other",
    endedAt: overrides.endedAt ?? new Date(startedAt.getTime() + 100),
    durationMs: overrides.durationMs ?? 100,
    statusCode: 1,
    serviceName: "fixture-agent",
    scopeName: "fixture",
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
    startedAt,
  };
}

function experimentSpan(
  id: number,
  experimentName: string,
  experimentArm: string,
  traceIdValue: string,
  overrides: Partial<NewOtelSpan> = {},
): NewOtelSpan {
  return span({
    id: uuid(id),
    traceId: traceIdValue,
    spanId: spanId(id),
    experimentName,
    experimentArm,
    ...overrides,
  });
}

function decodedSearchSpan(
  trace: number,
  span: number,
  arm: string,
  hitCount: number,
): DecodedSpan {
  return {
    traceId: traceId(trace),
    spanId: spanId(span),
    parentSpanId: null,
    name: RATEL_SEARCH,
    kind: 1,
    startUnixMs: Date.parse("2026-07-30T10:00:00.000Z"),
    endUnixMs: Date.parse("2026-07-30T10:00:00.100Z"),
    attributes: {
      [RATEL.searchQuery]: "find a capability",
      [RATEL.searchTarget]: "skill",
      [RATEL.searchHitCount]: hitCount,
      [RATEL_EXPERIMENT.id]: "rankings",
      [RATEL_EXPERIMENT.arm]: arm,
    },
    events: [],
    statusCode: 1,
    resourceAttributes: {},
    scopeName: "fixture",
  };
}

function traceEventHit(targetId: string, rank: number) {
  return {
    rank,
    targetType: "skill" as const,
    targetId,
    score: null,
  };
}

function uuid(value: number): string {
  return `00000000-0000-8000-8000-${value.toString(16).padStart(12, "0")}`;
}

function spanId(value: number): string {
  return value.toString(16).padStart(16, "0");
}

function traceId(value: number): string {
  return value.toString(16).padStart(32, "0");
}
