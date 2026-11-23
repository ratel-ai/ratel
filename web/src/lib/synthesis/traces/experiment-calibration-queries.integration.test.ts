import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { toOtelLogRows } from "@/lib/ingest/otlp/log-rows";
import { insertOtelLogs, insertOtelSpans } from "@/lib/ingest/otlp/queries";
import { toOtelSpanRows } from "@/lib/ingest/otlp/span-rows";
import type { DecodedLogRecord, DecodedSpan } from "@/lib/ingest/otlp/types";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type {
  ComparisonFacet,
  ComparisonFilterSelection,
} from "@/lib/synthesis/experiments/calibration-types";
import {
  type ComparedQueriesDb,
  countExperimentComparisons,
  countRankingComparisons,
  type ExperimentCalibrationQueriesDb,
  getRankingComparisonSummary,
  getSelectionDetail,
  listComparedQueries,
  listRankingComparisons,
} from "./experiment-calibration-queries";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const SINCE = new Date("2026-07-01T00:00:00.000Z");
const UNTIL = new Date("2026-08-01T00:00:00.000Z");
const WINDOW = { since: SINCE, until: UNTIL };

type TestDb = ExperimentCalibrationQueriesDb &
  ComparedQueriesDb &
  NonNullable<Parameters<typeof insertOtelLogs>[2]> &
  NonNullable<Parameters<typeof insertOtelSpans>[2]>;

test("countExperimentComparisons counts comparison records per experiment within project and window", async () => {
  const { client, db } = await setup();
  await insertRecords(db, PROJECT_ID, [
    // Mismatch counting is arm-agnostic: exact_order=false counts even when
    // the served/shadow arm attrs are absent from the record.
    logRecord("comparison", "2026-07-10T10:00:00.000Z", {
      "ratel.experiment.agreement.exact_order": false,
    }),
    logRecord("comparison", "2026-07-10T10:01:00.000Z", {
      "ratel.experiment.agreement.exact_order": true,
    }),
    logRecord("comparison", "2026-08-02T10:00:00.000Z"),
    logRecord(
      "comparison",
      "2026-07-10T10:02:00.000Z",
      {},
      {
        experiment: "other",
      },
    ),
    logRecord("results", "2026-07-10T10:03:00.000Z"),
    logRecord(
      "comparison",
      "2026-07-10T10:04:00.000Z",
      {},
      {
        experiment: "unlisted",
      },
    ),
  ]);
  await insertRecords(db, OTHER_PROJECT_ID, [logRecord("comparison", "2026-07-10T10:05:00.000Z")]);

  assert.deepEqual(
    await countExperimentComparisons(PROJECT_ID, ["ranking", "other", "missing"], WINDOW, db),
    [
      { experimentName: "other", comparisonCount: 1, mismatchCount: 0 },
      { experimentName: "ranking", comparisonCount: 2, mismatchCount: 1 },
    ],
  );
  assert.deepEqual(await countExperimentComparisons(PROJECT_ID, [], WINDOW, db), []);
  await client.close();
});

test("ranking comparison filters count categories and paginate newest-first", async () => {
  const { client, db } = await setup();
  const comparison = (occurredAt: string, attributes: Record<string, unknown>) =>
    logRecord("comparison", occurredAt, {
      "ratel.experiment.agreement.exact_order": false,
      "ratel.experiment.served.outcome": "ok",
      "ratel.experiment.shadow.outcome": "ok",
      ...attributes,
    });
  await insertRecords(db, PROJECT_ID, [
    comparison("2026-07-10T10:00:00.000Z", {
      "ratel.experiment.agreement.top1": false,
      "ratel.experiment.served.hit_count": 3,
      "ratel.experiment.shadow.hit_count": 3,
      "ratel.experiment.agreement.overlap_count": 3,
    }),
    comparison("2026-07-10T10:01:00.000Z", {
      "ratel.experiment.agreement.top1": true,
      "ratel.experiment.served.hit_count": 3,
      "ratel.experiment.shadow.hit_count": 3,
      "ratel.experiment.agreement.overlap_count": 3,
    }),
    comparison("2026-07-10T10:02:00.000Z", {
      "ratel.experiment.agreement.top1": true,
      "ratel.experiment.served.hit_count": 3,
      "ratel.experiment.shadow.hit_count": 2,
      "ratel.experiment.agreement.overlap_count": 2,
    }),
    comparison("2026-07-10T10:03:00.000Z", {
      "ratel.experiment.agreement.top1": true,
      "ratel.experiment.served.hit_count": 2,
      "ratel.experiment.shadow.hit_count": 3,
      "ratel.experiment.agreement.overlap_count": 2,
    }),
    comparison("2026-07-10T10:04:00.000Z", {
      "ratel.experiment.agreement.top1": true,
      "ratel.experiment.served.outcome": "ok",
      "ratel.experiment.shadow.outcome": "timeout",
    }),
    logRecord("comparison", "2026-07-10T10:05:00.000Z", {
      "ratel.experiment.agreement.exact_order": true,
    }),
  ]);

  assert.deepEqual(
    await Promise.all(
      (
        [
          { scope: "mismatch", facets: [], match: "any" },
          { scope: "mismatch", facets: ["top1"], match: "any" },
          { scope: "mismatch", facets: ["order"], match: "any" },
          { scope: "mismatch", facets: ["missing"], match: "any" },
          { scope: "mismatch", facets: ["added"], match: "any" },
          { scope: "mismatch", facets: ["outcome"], match: "any" },
          { scope: "all", facets: [], match: "any" },
        ] satisfies ComparisonFilterSelection[]
      ).map((selection) =>
        countRankingComparisons(PROJECT_ID, "ranking", WINDOW, { selection }, db),
      ),
    ),
    [5, 1, 2, 1, 1, 1, 6],
  );
  const page = await listRankingComparisons(
    PROJECT_ID,
    "ranking",
    WINDOW,
    {
      selection: { scope: "mismatch", facets: [], match: "any" },
      limit: 2,
      offset: 2,
    },
    db,
  );
  assert.deepEqual(
    page.map((row) => row.occurredAt.toISOString()),
    ["2026-07-10T10:02:00.000Z", "2026-07-10T10:01:00.000Z"],
  );
  await client.close();
});

test("facet filters overlap instead of excluding each other, and combine with any/all", async () => {
  const { client, db } = await setup();
  await insertRecords(db, PROJECT_ID, [
    // Pure reorder: same three tools, different order.
    ...comparisonWithResults("2026-07-10T10:00:00.000Z", {
      served: ["a", "b", "c"],
      shadow: ["c", "a", "b"],
      top1: false,
    }),
    // Reorder *and* a dropped tool — the case the old `order` filter hid.
    ...comparisonWithResults("2026-07-10T10:01:00.000Z", {
      served: ["a", "b", "c"],
      shadow: ["c", "a"],
      top1: false,
    }),
    // Tail drop only: shared tools keep their ranks, so this is not a reorder.
    ...comparisonWithResults("2026-07-10T10:02:00.000Z", {
      served: ["a", "b", "c"],
      shadow: ["a", "b"],
      top1: true,
    }),
    // Tail addition only.
    ...comparisonWithResults("2026-07-10T10:03:00.000Z", {
      served: ["a", "b"],
      shadow: ["a", "b", "c"],
      top1: true,
    }),
    // Shadow returned nothing: a missing tool plus an outcome change.
    ...comparisonWithResults("2026-07-10T10:04:00.000Z", {
      served: ["a"],
      shadow: [],
      top1: false,
      shadowOutcome: "empty",
    }),
    // Reorder whose ranked lists were never exported: set equality still flags it.
    ...comparisonWithResults("2026-07-10T10:05:00.000Z", {
      served: ["a", "b"],
      shadow: ["b", "a"],
      top1: false,
      exportResults: false,
    }),
    // Agreeing comparison: never part of a flagged set.
    ...comparisonWithResults("2026-07-10T10:06:00.000Z", {
      served: ["a", "b"],
      shadow: ["a", "b"],
      top1: true,
      exactOrder: true,
    }),
  ]);

  const count = (selection: ComparisonFilterSelection) =>
    countRankingComparisons(PROJECT_ID, "ranking", WINDOW, { selection }, db);
  const facets = (
    facets: ComparisonFacet[],
    match: ComparisonFilterSelection["match"] = "any",
  ): ComparisonFilterSelection => ({ scope: "mismatch", facets, match });

  assert.deepEqual(
    await Promise.all([
      count(facets([])),
      count(facets(["top1"])),
      count(facets(["order"])),
      count(facets(["missing"])),
      count(facets(["added"])),
      count(facets(["outcome"])),
      count(facets(["order", "missing"], "any")),
      count(facets(["order", "missing"], "all")),
      count(facets(["top1", "added"], "all")),
      count({ scope: "all", facets: [], match: "any" }),
      count({ scope: "all", facets: ["added"], match: "any" }),
    ]),
    [6, 4, 3, 3, 1, 1, 5, 1, 0, 7, 1],
  );

  const reordered = await listRankingComparisons(
    PROJECT_ID,
    "ranking",
    WINDOW,
    { selection: facets(["order"]) },
    db,
  );
  assert.deepEqual(
    reordered.map((row) => row.occurredAt.toISOString()),
    ["2026-07-10T10:05:00.000Z", "2026-07-10T10:01:00.000Z", "2026-07-10T10:00:00.000Z"],
  );
  await client.close();
});

test("getRankingComparisonSummary groups agreement metrics by served/shadow arm pair", async () => {
  const { client, db } = await setup();
  await insertRecords(db, PROJECT_ID, [
    logRecord("comparison", "2026-07-10T10:00:00.000Z", {
      "ratel.experiment.served.arm": "baseline",
      "ratel.experiment.shadow.arm": "candidate",
      "ratel.experiment.agreement.top1": true,
      "ratel.experiment.agreement.exact_order": true,
      "ratel.experiment.agreement.jaccard_at_k": 0.75,
      "ratel.experiment.agreement.k": 3,
    }),
    logRecord("comparison", "2026-07-10T10:01:00.000Z", {
      "ratel.experiment.served.arm": "baseline",
      "ratel.experiment.shadow.arm": "candidate",
      "ratel.experiment.agreement.top1": true,
      "ratel.experiment.agreement.exact_order": false,
      "ratel.experiment.agreement.jaccard_at_k": 0.25,
      "ratel.experiment.agreement.k": 3,
    }),
    logRecord("comparison", "2026-07-10T10:02:00.000Z", {
      "ratel.experiment.served.arm": "baseline",
      "ratel.experiment.shadow.arm": "candidate",
      "ratel.experiment.agreement.top1": false,
      "ratel.experiment.agreement.exact_order": false,
      "ratel.experiment.agreement.jaccard_at_k": 0.5,
      "ratel.experiment.agreement.k": 5,
    }),
    logRecord("comparison", "2026-07-10T10:03:00.000Z", {
      "ratel.experiment.served.arm": "baseline",
      "ratel.experiment.shadow.arm": "candidate",
      "ratel.experiment.agreement.top1": false,
      "ratel.experiment.agreement.exact_order": true,
      "ratel.experiment.agreement.jaccard_at_k": 0.5,
      "ratel.experiment.agreement.k": 5,
    }),
    // No agreement attrs: counts toward comparisonCount only.
    logRecord("comparison", "2026-07-10T10:04:00.000Z", {
      "ratel.experiment.served.arm": "baseline",
      "ratel.experiment.shadow.arm": "candidate",
    }),
    logRecord("comparison", "2026-07-10T10:05:00.000Z", {
      "ratel.experiment.served.arm": "legacy",
      "ratel.experiment.shadow.arm": "candidate",
      "ratel.experiment.agreement.top1": true,
      "ratel.experiment.agreement.exact_order": true,
      "ratel.experiment.agreement.jaccard_at_k": 1,
      "ratel.experiment.agreement.k": 3,
    }),
    // Shadow arm attr absent: falls back to the promoted experiment_arm column.
    logRecord(
      "comparison",
      "2026-07-10T10:06:00.000Z",
      { "ratel.experiment.served.arm": "baseline" },
      { arm: "fallback-arm" },
    ),
    // Served arm attr absent: excluded (both arms required).
    logRecord("comparison", "2026-07-10T10:07:00.000Z", {
      "ratel.experiment.shadow.arm": "candidate",
    }),
    // Empty served arm: excluded.
    logRecord("comparison", "2026-07-10T10:08:00.000Z", {
      "ratel.experiment.served.arm": "",
      "ratel.experiment.shadow.arm": "candidate",
    }),
    // Non-comparison event: excluded even with pair attrs.
    logRecord("results", "2026-07-10T10:09:00.000Z", {
      "ratel.experiment.served.arm": "baseline",
      "ratel.experiment.shadow.arm": "candidate",
    }),
    // Outside window.
    logRecord("comparison", "2026-08-02T10:00:00.000Z", {
      "ratel.experiment.served.arm": "baseline",
      "ratel.experiment.shadow.arm": "candidate",
    }),
    // Other experiment.
    logRecord(
      "comparison",
      "2026-07-10T10:10:00.000Z",
      {
        "ratel.experiment.served.arm": "baseline",
        "ratel.experiment.shadow.arm": "candidate",
      },
      { experiment: "other" },
    ),
  ]);
  await insertRecords(db, OTHER_PROJECT_ID, [
    logRecord("comparison", "2026-07-10T10:11:00.000Z", {
      "ratel.experiment.served.arm": "baseline",
      "ratel.experiment.shadow.arm": "candidate",
    }),
  ]);

  assert.deepEqual(await getRankingComparisonSummary(PROJECT_ID, "ranking", WINDOW, db), [
    {
      servedArm: "baseline",
      shadowArm: "candidate",
      comparisonCount: 5,
      mismatchCount: 2,
      top1Rate: 0.5,
      exactOrderRate: 0.5,
      averageJaccardAtK: 0.5,
      jaccardByK: [
        { k: 3, count: 2, mean: 0.5 },
        { k: 5, count: 2, mean: 0.5 },
      ],
      served: emptySideStats(),
      shadow: emptySideStats(),
    },
    {
      servedArm: "baseline",
      shadowArm: "fallback-arm",
      comparisonCount: 1,
      mismatchCount: 0,
      top1Rate: null,
      exactOrderRate: null,
      averageJaccardAtK: null,
      jaccardByK: [],
      served: emptySideStats(),
      shadow: emptySideStats(),
    },
    {
      servedArm: "legacy",
      shadowArm: "candidate",
      comparisonCount: 1,
      mismatchCount: 0,
      top1Rate: 1,
      exactOrderRate: 1,
      averageJaccardAtK: 1,
      jaccardByK: [{ k: 3, count: 1, mean: 1 }],
      served: emptySideStats(),
      shadow: emptySideStats(),
    },
  ]);
  await client.close();
});

test("getRankingComparisonSummary aggregates per-side outcomes, error rate, and duration percentiles", async () => {
  const { client, db } = await setup();
  await insertRecords(db, PROJECT_ID, [
    logRecord("comparison", "2026-07-10T10:00:00.000Z", {
      "ratel.experiment.served.arm": "baseline",
      "ratel.experiment.shadow.arm": "candidate",
      "ratel.experiment.served.outcome": "ok",
      "ratel.experiment.served.duration_ms": 100,
      "ratel.experiment.shadow.outcome": "ok",
      "ratel.experiment.shadow.duration_ms": 10,
    }),
    logRecord("comparison", "2026-07-10T10:01:00.000Z", {
      "ratel.experiment.served.arm": "baseline",
      "ratel.experiment.shadow.arm": "candidate",
      "ratel.experiment.served.outcome": "ok",
      "ratel.experiment.served.duration_ms": 200,
      "ratel.experiment.shadow.outcome": "ok",
      "ratel.experiment.shadow.duration_ms": 20,
    }),
    logRecord("comparison", "2026-07-10T10:02:00.000Z", {
      "ratel.experiment.served.arm": "baseline",
      "ratel.experiment.shadow.arm": "candidate",
      "ratel.experiment.served.outcome": "error",
      "ratel.experiment.served.duration_ms": 300,
      "ratel.experiment.shadow.outcome": "ok",
      "ratel.experiment.shadow.duration_ms": 30,
    }),
    logRecord("comparison", "2026-07-10T10:03:00.000Z", {
      "ratel.experiment.served.arm": "baseline",
      "ratel.experiment.shadow.arm": "candidate",
      "ratel.experiment.served.outcome": "timeout",
      "ratel.experiment.served.duration_ms": 400,
      "ratel.experiment.shadow.outcome": "empty",
      "ratel.experiment.shadow.duration_ms": 40,
    }),
    // No outcome/duration attrs: excluded from side stats, counted overall.
    logRecord("comparison", "2026-07-10T10:04:00.000Z", {
      "ratel.experiment.served.arm": "baseline",
      "ratel.experiment.shadow.arm": "candidate",
    }),
  ]);

  assert.deepEqual(await getRankingComparisonSummary(PROJECT_ID, "ranking", WINDOW, db), [
    {
      servedArm: "baseline",
      shadowArm: "candidate",
      comparisonCount: 5,
      mismatchCount: 0,
      top1Rate: null,
      exactOrderRate: null,
      averageJaccardAtK: null,
      jaccardByK: [],
      served: {
        outcomes: { error: 1, ok: 2, timeout: 1 },
        errorRate: 0.5,
        averageDurationMs: 250,
        p50DurationMs: 250,
        p95DurationMs: 385,
      },
      shadow: {
        outcomes: { empty: 1, ok: 3 },
        errorRate: 0,
        averageDurationMs: 25,
        p50DurationMs: 25,
        p95DurationMs: 38.5,
      },
    },
  ]);
  await client.close();
});

test("listRankingComparisons maps comparison rows newest-first and stitches per-arm results", async () => {
  const { client, db } = await setup();
  const TRACE_1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await insertRecords(db, PROJECT_ID, [
    logRecord(
      "comparison",
      "2026-07-10T10:00:00.000Z",
      {
        "ratel.experiment.query": "find tasks assigned to me",
        "ratel.experiment.served.arm": "baseline",
        "ratel.experiment.shadow.arm": "candidate",
        "ratel.experiment.served.outcome": "ok",
        "ratel.experiment.served.duration_ms": 120,
        "ratel.experiment.served.hit_count": 5,
        "ratel.experiment.shadow.outcome": "ok",
        "ratel.experiment.shadow.duration_ms": 80,
        "ratel.experiment.shadow.hit_count": 4,
        "ratel.experiment.agreement.top1": true,
        "ratel.experiment.agreement.exact_order": true,
        "ratel.experiment.agreement.overlap_count": 3,
        "ratel.experiment.agreement.jaccard_at_k": 1,
        "ratel.experiment.agreement.k": 3,
      },
      { selectionId: "s1", traceId: TRACE_1 },
    ),
    logRecord(
      "results",
      "2026-07-10T10:00:01.000Z",
      {
        "ratel.experiment.result_ids": ["a", "b", "c"],
        "ratel.experiment.result_scores": [0.9, 0.8, 0.7],
      },
      { selectionId: "s1", arm: "baseline" },
    ),
    // Duplicate served-arm results record: must not multiply comparison rows.
    logRecord(
      "results",
      "2026-07-10T10:00:02.000Z",
      {
        "ratel.experiment.result_ids": ["a", "b", "c"],
        "ratel.experiment.result_scores": [0.9, 0.8, 0.7],
      },
      { selectionId: "s1", arm: "baseline" },
    ),
    logRecord(
      "results",
      "2026-07-10T10:00:03.000Z",
      {
        "ratel.experiment.result_ids": ["b", "a", "c"],
        "ratel.experiment.result_scores": [0.95, 0.9, 0.2],
      },
      { selectionId: "s1", arm: "candidate" },
    ),
    // Results for an arm that is neither served nor shadow: ignored.
    logRecord(
      "results",
      "2026-07-10T10:00:04.000Z",
      { "ratel.experiment.result_ids": ["z"] },
      { selectionId: "s1", arm: "unrelated" },
    ),
    logRecord(
      "comparison",
      "2026-07-10T10:05:00.000Z",
      {
        "ratel.experiment.query": "mark the task done",
        "ratel.experiment.served.arm": "baseline",
        "ratel.experiment.shadow.arm": "candidate",
        "ratel.experiment.served.outcome": "ok",
        "ratel.experiment.served.duration_ms": 100,
        "ratel.experiment.served.hit_count": 3,
        "ratel.experiment.shadow.outcome": "ok",
        "ratel.experiment.shadow.duration_ms": 50,
        "ratel.experiment.shadow.hit_count": 2,
        "ratel.experiment.agreement.top1": false,
        "ratel.experiment.agreement.exact_order": false,
        "ratel.experiment.agreement.overlap_count": 1,
        "ratel.experiment.agreement.jaccard_at_k": 0.25,
        "ratel.experiment.agreement.k": 3,
      },
      { selectionId: "s2" },
    ),
    // Results occur outside the window: still stitched (selection-keyed fetch).
    logRecord(
      "results",
      "2026-08-05T10:00:00.000Z",
      {
        "ratel.experiment.result_ids": ["a"],
        "ratel.experiment.result_scores": [1],
      },
      { selectionId: "s2", arm: "baseline" },
    ),
    // Results for a different selection: not stitched.
    logRecord(
      "results",
      "2026-07-10T10:05:01.000Z",
      { "ratel.experiment.result_ids": ["x"] },
      { selectionId: "s-other", arm: "baseline" },
    ),
    logRecord(
      "comparison",
      "2026-07-10T10:10:00.000Z",
      {
        "ratel.experiment.served.arm": "baseline",
        "ratel.experiment.shadow.arm": "candidate",
      },
      { selectionId: "s3", traceId: null },
    ),
    // Outside window / other experiment: excluded from the list.
    logRecord(
      "comparison",
      "2026-08-02T10:00:00.000Z",
      {
        "ratel.experiment.served.arm": "baseline",
        "ratel.experiment.shadow.arm": "candidate",
      },
      { selectionId: "s-outside" },
    ),
    logRecord(
      "comparison",
      "2026-07-10T10:11:00.000Z",
      {
        "ratel.experiment.served.arm": "baseline",
        "ratel.experiment.shadow.arm": "candidate",
      },
      { selectionId: "s-other-exp", experiment: "other" },
    ),
  ]);
  await insertRecords(db, OTHER_PROJECT_ID, [
    logRecord(
      "comparison",
      "2026-07-10T10:12:00.000Z",
      {
        "ratel.experiment.served.arm": "baseline",
        "ratel.experiment.shadow.arm": "candidate",
      },
      { selectionId: "s-other-project" },
    ),
  ]);

  const row1 = {
    selectionId: "s1",
    occurredAt: new Date("2026-07-10T10:00:00.000Z"),
    traceId: TRACE_1,
    query: "find tasks assigned to me",
    servedArm: "baseline",
    shadowArm: "candidate",
    servedOutcome: "ok",
    shadowOutcome: "ok",
    servedDurationMs: 120,
    shadowDurationMs: 80,
    servedHitCount: 5,
    shadowHitCount: 4,
    top1: true,
    exactOrder: true,
    overlapCount: 3,
    jaccardAtK: 1,
    agreementK: 3,
    servedResultIds: ["a", "b", "c"],
    shadowResultIds: ["b", "a", "c"],
    servedResultScores: [0.9, 0.8, 0.7],
    shadowResultScores: [0.95, 0.9, 0.2],
  };
  const row2 = {
    selectionId: "s2",
    occurredAt: new Date("2026-07-10T10:05:00.000Z"),
    traceId: "0123456789abcdef0123456789abcdef",
    query: "mark the task done",
    servedArm: "baseline",
    shadowArm: "candidate",
    servedOutcome: "ok",
    shadowOutcome: "ok",
    servedDurationMs: 100,
    shadowDurationMs: 50,
    servedHitCount: 3,
    shadowHitCount: 2,
    top1: false,
    exactOrder: false,
    overlapCount: 1,
    jaccardAtK: 0.25,
    agreementK: 3,
    servedResultIds: ["a"],
    shadowResultIds: null,
    servedResultScores: [1],
    shadowResultScores: null,
  };
  const row3 = {
    selectionId: "s3",
    occurredAt: new Date("2026-07-10T10:10:00.000Z"),
    traceId: null,
    query: null,
    servedArm: "baseline",
    shadowArm: "candidate",
    servedOutcome: null,
    shadowOutcome: null,
    servedDurationMs: null,
    shadowDurationMs: null,
    servedHitCount: null,
    shadowHitCount: null,
    top1: null,
    exactOrder: null,
    overlapCount: null,
    jaccardAtK: null,
    agreementK: null,
    servedResultIds: null,
    shadowResultIds: null,
    servedResultScores: null,
    shadowResultScores: null,
  };

  assert.deepEqual(await listRankingComparisons(PROJECT_ID, "ranking", WINDOW, {}, db), [
    row3,
    row2,
    row1,
  ]);
  assert.deepEqual(
    await listRankingComparisons(
      PROJECT_ID,
      "ranking",
      WINDOW,
      { selection: { scope: "mismatch", facets: [], match: "any" } },
      db,
    ),
    [row2],
  );
  assert.deepEqual(await listRankingComparisons(PROJECT_ID, "ranking", WINDOW, { limit: 2 }, db), [
    row3,
    row2,
  ]);
  await client.close();
});

test("malformed experiment attrs degrade to nulls instead of throwing", async () => {
  const { client, db } = await setup();
  await insertRecords(db, PROJECT_ID, [
    logRecord(
      "comparison",
      "2026-07-10T10:00:00.000Z",
      {
        "ratel.experiment.query": 42,
        "ratel.experiment.served.arm": 42,
        "ratel.experiment.shadow.arm": "candidate",
        "ratel.experiment.served.outcome": 42,
        "ratel.experiment.shadow.outcome": false,
        "ratel.experiment.served.duration_ms": "fast",
        "ratel.experiment.shadow.duration_ms": true,
        "ratel.experiment.served.hit_count": "many",
        "ratel.experiment.shadow.hit_count": [3],
        "ratel.experiment.agreement.top1": "yes",
        "ratel.experiment.agreement.exact_order": 1,
        "ratel.experiment.agreement.overlap_count": "three",
        "ratel.experiment.agreement.jaccard_at_k": "high",
        "ratel.experiment.agreement.k": "3",
      },
      { selectionId: "s-malformed" },
    ),
    logRecord(
      "results",
      "2026-07-10T10:00:01.000Z",
      {
        "ratel.experiment.result_ids": "not-an-array",
        "ratel.experiment.result_scores": { first: 1 },
      },
      { selectionId: "s-malformed", arm: "candidate" },
    ),
    logRecord(
      "comparison",
      "2026-07-10T10:01:00.000Z",
      {
        "ratel.experiment.served.arm": "baseline",
        "ratel.experiment.shadow.arm": "candidate",
      },
      { selectionId: "s-mixed" },
    ),
    // Mixed-type arrays keep only string ids / finite number scores.
    logRecord(
      "results",
      "2026-07-10T10:01:01.000Z",
      {
        "ratel.experiment.result_ids": ["a", 1, "b", null],
        "ratel.experiment.result_scores": ["x", 1, 2.5, null],
      },
      { selectionId: "s-mixed", arm: "baseline" },
    ),
  ]);

  assert.deepEqual(await listRankingComparisons(PROJECT_ID, "ranking", WINDOW, {}, db), [
    {
      selectionId: "s-mixed",
      occurredAt: new Date("2026-07-10T10:01:00.000Z"),
      traceId: "0123456789abcdef0123456789abcdef",
      query: null,
      servedArm: "baseline",
      shadowArm: "candidate",
      servedOutcome: null,
      shadowOutcome: null,
      servedDurationMs: null,
      shadowDurationMs: null,
      servedHitCount: null,
      shadowHitCount: null,
      top1: null,
      exactOrder: null,
      overlapCount: null,
      jaccardAtK: null,
      agreementK: null,
      servedResultIds: ["a", "b"],
      shadowResultIds: null,
      servedResultScores: [1, 2.5],
      shadowResultScores: null,
    },
    {
      selectionId: "s-malformed",
      occurredAt: new Date("2026-07-10T10:00:00.000Z"),
      traceId: "0123456789abcdef0123456789abcdef",
      query: null,
      servedArm: null,
      shadowArm: "candidate",
      servedOutcome: null,
      shadowOutcome: null,
      servedDurationMs: null,
      shadowDurationMs: null,
      servedHitCount: null,
      shadowHitCount: null,
      top1: null,
      exactOrder: null,
      overlapCount: null,
      jaccardAtK: null,
      agreementK: null,
      servedResultIds: null,
      shadowResultIds: null,
      servedResultScores: null,
      shadowResultScores: null,
    },
  ]);
  // The malformed row has no served arm, so only the mixed pair aggregates.
  assert.deepEqual(await getRankingComparisonSummary(PROJECT_ID, "ranking", WINDOW, db), [
    {
      servedArm: "baseline",
      shadowArm: "candidate",
      comparisonCount: 1,
      mismatchCount: 0,
      top1Rate: null,
      exactOrderRate: null,
      averageJaccardAtK: null,
      jaccardByK: [],
      served: emptySideStats(),
      shadow: emptySideStats(),
    },
  ]);
  await client.close();
});

test("getSelectionDetail returns ordered selection records with span probe", async () => {
  const { client, db } = await setup();
  const TRACE_D = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const TRACE_UNSAMPLED = "cccccccccccccccccccccccccccccccc";
  await insertRecords(db, PROJECT_ID, [
    logRecord(
      "results",
      "2026-07-10T10:00:00.000Z",
      { "ratel.experiment.result_ids": ["a"] },
      {
        selectionId: "s-detail",
        arm: "baseline",
        role: "serving",
        traceId: null,
      },
    ),
    logRecord(
      "results",
      "2026-07-10T10:00:01.000Z",
      { "ratel.experiment.result_ids": ["b"] },
      { selectionId: "s-detail", arm: "candidate", traceId: TRACE_D },
    ),
    // Same timestamp as the results record above: event_name breaks the tie.
    logRecord(
      "comparison",
      "2026-07-10T10:00:01.000Z",
      { "ratel.experiment.agreement.top1": true },
      { selectionId: "s-detail", arm: "candidate", traceId: TRACE_D },
    ),
    logRecord(
      "results",
      "2026-07-10T11:00:00.000Z",
      {},
      {
        selectionId: "s-no-span",
        traceId: TRACE_UNSAMPLED,
      },
    ),
    logRecord(
      "results",
      "2026-07-10T12:00:00.000Z",
      {},
      {
        selectionId: "s-no-trace",
        traceId: null,
      },
    ),
  ]);
  await insertRecords(db, OTHER_PROJECT_ID, [
    logRecord(
      "drop",
      "2026-07-10T13:00:00.000Z",
      {},
      {
        selectionId: "s-detail",
      },
    ),
  ]);
  await insertSpan(db, PROJECT_ID, decodedSpan(TRACE_D));
  // A span for the same trace in another project must not count.
  await insertSpan(db, OTHER_PROJECT_ID, decodedSpan(TRACE_UNSAMPLED));

  const detail = await getSelectionDetail(PROJECT_ID, "s-detail", db);
  assert.ok(detail);
  const { records, ...header } = detail;
  assert.deepEqual(header, {
    selectionId: "s-detail",
    experimentName: "ranking",
    traceId: TRACE_D,
    traceHasSpans: true,
  });
  assert.deepEqual(
    records.map(({ id: _id, ...record }) => record),
    [
      {
        eventName: "ratel.experiment.results",
        occurredAt: new Date("2026-07-10T10:00:00.000Z"),
        traceId: null,
        arm: "baseline",
        role: "serving",
        experimentAttrs: {
          "ratel.experiment.id": "ranking",
          "ratel.experiment.selection_id": "s-detail",
          "ratel.experiment.arm": "baseline",
          "ratel.experiment.role": "serving",
          "ratel.experiment.result_ids": ["a"],
        },
      },
      {
        eventName: "ratel.experiment.comparison",
        occurredAt: new Date("2026-07-10T10:00:01.000Z"),
        traceId: TRACE_D,
        arm: "candidate",
        role: "shadow",
        experimentAttrs: {
          "ratel.experiment.id": "ranking",
          "ratel.experiment.selection_id": "s-detail",
          "ratel.experiment.arm": "candidate",
          "ratel.experiment.role": "shadow",
          "ratel.experiment.agreement.top1": true,
        },
      },
      {
        eventName: "ratel.experiment.results",
        occurredAt: new Date("2026-07-10T10:00:01.000Z"),
        traceId: TRACE_D,
        arm: "candidate",
        role: "shadow",
        experimentAttrs: {
          "ratel.experiment.id": "ranking",
          "ratel.experiment.selection_id": "s-detail",
          "ratel.experiment.arm": "candidate",
          "ratel.experiment.role": "shadow",
          "ratel.experiment.result_ids": ["b"],
        },
      },
    ],
  );
  assert.equal(new Set(records.map((record) => record.id)).size, 3);

  const noSpan = await getSelectionDetail(PROJECT_ID, "s-no-span", db);
  assert.equal(noSpan?.traceId, TRACE_UNSAMPLED);
  assert.equal(noSpan?.traceHasSpans, false);

  const noTrace = await getSelectionDetail(PROJECT_ID, "s-no-trace", db);
  assert.equal(noTrace?.traceId, null);
  assert.equal(noTrace?.traceHasSpans, false);

  assert.equal(await getSelectionDetail(PROJECT_ID, "s-unknown", db), null);
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

async function insertRecords(
  db: TestDb,
  projectId: string,
  records: DecodedLogRecord[],
): Promise<void> {
  const { rows, dropped } = toOtelLogRows(projectId, records);
  assert.equal(dropped, 0);
  assert.deepEqual(await insertOtelLogs(projectId, rows, db), {
    accepted: rows.length,
  });
}

async function insertSpan(db: TestDb, projectId: string, span: DecodedSpan): Promise<void> {
  const rows = toOtelSpanRows(projectId, [span]);
  assert.deepEqual(await insertOtelSpans(projectId, rows, db), {
    accepted: rows.length,
  });
}

function logRecord(
  event: string,
  occurredAt: string,
  attributes: Record<string, unknown> = {},
  overrides: {
    experiment?: string;
    arm?: string | null;
    role?: string;
    selectionId?: string | null;
    traceId?: string | null;
  } = {},
): DecodedLogRecord {
  const occurredAtMs = Date.parse(occurredAt);
  const arm = overrides.arm === undefined ? "candidate" : overrides.arm;
  const selectionId =
    overrides.selectionId === undefined ? `sel-${occurredAtMs}` : overrides.selectionId;
  const traceId =
    overrides.traceId === undefined ? "0123456789abcdef0123456789abcdef" : overrides.traceId;
  return {
    eventName: `ratel.experiment.${event}`,
    timeUnixNano: (BigInt(occurredAtMs) * BigInt(1_000_000)).toString(),
    timeUnixMs: occurredAtMs,
    observedTimeUnixNano: "",
    observedTimeUnixMs: 0,
    traceId,
    spanId: traceId === null ? null : "0123456789abcdef",
    severityNumber: 9,
    severityText: "INFO",
    body: null,
    attributes: {
      "ratel.experiment.id": overrides.experiment ?? "ranking",
      ...(selectionId === null ? {} : { "ratel.experiment.selection_id": selectionId }),
      ...(arm === null ? {} : { "ratel.experiment.arm": arm }),
      "ratel.experiment.role": overrides.role ?? "shadow",
      ...attributes,
    },
    resourceAttributes: { "service.name": "fixture-agent" },
    scopeName: "@ratel-ai/sdk",
  };
}

/**
 * One comparison record plus both arms' exported rankings, with the agreement
 * attrs derived from the two lists so fixtures stay SDK-faithful.
 */
function comparisonWithResults(
  occurredAt: string,
  options: {
    served: string[];
    shadow: string[];
    top1: boolean;
    exactOrder?: boolean;
    servedOutcome?: string;
    shadowOutcome?: string;
    exportResults?: boolean;
  },
): DecodedLogRecord[] {
  const selectionId = `sel-${Date.parse(occurredAt)}`;
  const overlapCount = options.served.filter((id) => options.shadow.includes(id)).length;
  const comparison = logRecord(
    "comparison",
    occurredAt,
    {
      "ratel.experiment.served.arm": "baseline",
      "ratel.experiment.shadow.arm": "candidate",
      "ratel.experiment.served.outcome": options.servedOutcome ?? "ok",
      "ratel.experiment.shadow.outcome": options.shadowOutcome ?? "ok",
      "ratel.experiment.served.hit_count": options.served.length,
      "ratel.experiment.shadow.hit_count": options.shadow.length,
      "ratel.experiment.agreement.overlap_count": overlapCount,
      "ratel.experiment.agreement.top1": options.top1,
      "ratel.experiment.agreement.exact_order": options.exactOrder ?? false,
    },
    { selectionId },
  );
  if (options.exportResults === false) return [comparison];
  return [
    comparison,
    logRecord(
      "results",
      occurredAt,
      { "ratel.experiment.result_ids": options.served },
      { selectionId, arm: "baseline", role: "served" },
    ),
    logRecord(
      "results",
      occurredAt,
      { "ratel.experiment.result_ids": options.shadow },
      { selectionId, arm: "candidate" },
    ),
  ];
}

function emptySideStats() {
  return {
    outcomes: {},
    errorRate: null,
    averageDurationMs: null,
    p50DurationMs: null,
    p95DurationMs: null,
  };
}

function decodedSpan(traceId: string): DecodedSpan {
  return {
    traceId,
    spanId: "00000000000000aa",
    parentSpanId: null,
    name: "agent.run",
    kind: 1,
    startUnixMs: Date.parse("2026-07-10T10:00:00.000Z"),
    endUnixMs: Date.parse("2026-07-10T10:00:00.100Z"),
    attributes: {},
    events: [],
    statusCode: 1,
    resourceAttributes: { "service.name": "fixture-agent" },
    scopeName: "fixture",
  };
}

test("listComparedQueries groups by query, worst disagreement first", async () => {
  const { client, db } = await setup();
  await insertRecords(db, PROJECT_ID, [
    logRecord("comparison", "2026-07-10T10:00:00.000Z", {
      "ratel.experiment.query": "deploy the service",
      "ratel.experiment.agreement.exact_order": false,
    }),
    logRecord("comparison", "2026-07-10T10:01:00.000Z", {
      "ratel.experiment.query": "deploy the service",
      "ratel.experiment.agreement.exact_order": false,
    }),
    logRecord("comparison", "2026-07-10T10:02:00.000Z", {
      "ratel.experiment.query": "review a pull request",
      "ratel.experiment.agreement.exact_order": false,
    }),
    // Three agreements: more traffic than the loser above, but no disagreement,
    // so it must still sort below it.
    ...["03", "04", "05"].map((minute) =>
      logRecord("comparison", `2026-07-10T10:${minute}:00.000Z`, {
        "ratel.experiment.query": "write unit tests",
        "ratel.experiment.agreement.exact_order": true,
      }),
    ),
    // Excluded: no query attr, wrong event, outside the window, other project.
    logRecord("comparison", "2026-07-10T10:06:00.000Z", {
      "ratel.experiment.agreement.exact_order": false,
    }),
    logRecord("results", "2026-07-10T10:07:00.000Z", {
      "ratel.experiment.query": "not a comparison",
    }),
    logRecord("comparison", "2026-08-02T10:00:00.000Z", {
      "ratel.experiment.query": "outside the window",
    }),
  ]);
  await insertRecords(db, OTHER_PROJECT_ID, [
    logRecord("comparison", "2026-07-10T10:08:00.000Z", {
      "ratel.experiment.query": "another project",
      "ratel.experiment.agreement.exact_order": false,
    }),
  ]);

  const rows = await listComparedQueries(PROJECT_ID, WINDOW, 20, db);

  assert.deepEqual(
    rows.map(({ query, comparisons, mismatches }) => ({
      query,
      comparisons,
      mismatches,
    })),
    [
      { query: "deploy the service", comparisons: 2, mismatches: 2 },
      { query: "review a pull request", comparisons: 1, mismatches: 1 },
      { query: "write unit tests", comparisons: 3, mismatches: 0 },
    ],
  );
  assert.equal(
    rows[0].lastSeenAt.toISOString(),
    "2026-07-10T10:01:00.000Z",
    "lastSeenAt is the newest comparison in the group",
  );
  await client.close();
});

test("listComparedQueries honours its limit and returns nothing for an empty project", async () => {
  const { client, db } = await setup();
  await insertRecords(db, PROJECT_ID, [
    logRecord("comparison", "2026-07-10T10:00:00.000Z", {
      "ratel.experiment.query": "a",
      "ratel.experiment.agreement.exact_order": false,
    }),
    logRecord("comparison", "2026-07-10T10:01:00.000Z", {
      "ratel.experiment.query": "b",
      "ratel.experiment.agreement.exact_order": false,
    }),
  ]);

  assert.equal((await listComparedQueries(PROJECT_ID, WINDOW, 1, db)).length, 1);
  assert.deepEqual(await listComparedQueries(OTHER_PROJECT_ID, WINDOW, 20, db), []);
  await client.close();
});
