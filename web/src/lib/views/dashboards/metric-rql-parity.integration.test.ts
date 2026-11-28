import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  type Aggregation,
  type Bucket,
  type Dimension,
  type MetricQuery,
  metricQuery,
  QUERY_VERSION,
  type SqlQuery,
} from "@/lib/contracts/query";
import {
  METRICS,
  type MetricDefinition,
  nothingIsZero,
  type QueryScope,
} from "@/lib/synthesis/metrics/catalog";
import {
  type MetricResult,
  metricSeams,
  runQuery,
  type SqlResult,
} from "@/lib/synthesis/metrics/query";
import {
  PARITY_SCORERS,
  PARITY_WINDOW,
  PROJECT,
  seedMetricParity,
  traceDatabase,
} from "@/lib/synthesis/metrics/trace-fixture";
import { createPgRqlExecutor } from "@/lib/synthesis/rql/adapters/pg-executor";
import { RQL_VERSION } from "@/lib/synthesis/rql/compile";
import { sqlQueryRunner } from "@/lib/synthesis/rql/query";
import { createRqlGate } from "@/lib/synthesis/rql/run";
import { pglitePoolOf } from "@/lib/synthesis/rql/tests/test-support";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import { evaluationWindow, nextState } from "@/lib/views/alerts/domain";
import { metricAsRql } from "@/lib/views/dashboards/metric-rql";
import { sqlAsMetric } from "@/lib/views/dashboards/sql-chart";
import type { MetricChartKind } from "@/lib/views/dashboards/types";
import { formOf } from "@/lib/views/dashboards/widget";
import "@/lib/views/scorers/metrics";

/**
 * Every metric of the form is RQL: for each measure, aggregation, group-by, bucket and filter
 * that the form offers, the form compiler and the text of `metricAsRql` give the same numbers on
 * one fixture (`seedMetricParity`), drawn as the console draws them (`sqlAsMetric`), also under
 * a page filter. A cell is one widget under one page filter. The alert part reads by known time,
 * as a metric rule does, with late traces and an empty window.
 */

type Shape = Bucket | "total";
interface Cell {
  query: MetricQuery;
  shape: Shape;
  page: TraceFilter;
}

/** Each filter part of the form, alone, and a clause. A scorer limit for the scorer metrics. */
const FILTERS: [string, MetricQuery["filters"]][] = [
  ["models", { models: ["model-b"] }],
  ["tools", { tools: ["read", "search"] }],
  ["agents", { agents: ["helper"] }],
  ["services", { services: ["worker"] }],
  ["environments", { environments: ["prod"] }],
  ["mcp servers", { mcpServers: ["files"] }],
  ["status failed", { status: "failed" }],
  ["status ok", { status: "ok" }],
  ["min cost", { minCostUsd: 0.005 }],
  ["min tokens", { minTokens: 100 }],
  ["a clause", { environments: ["prod"], and: [{ models: ["model-a"] }] }],
];

/** Page filters of a dashboard or of Explore. */
const PAGE_FILTERS: [string, TraceFilter][] = [
  ["environments=[prod]", { environments: ["prod"] }],
  [
    "a model, a service and a minimum of tokens",
    { models: ["model-a"], services: ["worker"], minTokens: 100 },
  ],
  ["a clause on lists and a status", { status: "failed", and: [{ tools: ["read", "search"] }] }],
  [
    "a model the widget groups by",
    { models: ["model-a"], and: [{ agents: ["helper", "planner"] }] },
  ],
];

let database: Awaited<ReturnType<typeof traceDatabase>>;
let cells = 0;

before(async () => {
  database = await traceDatabase();
  await seedMetricParity(database);
  metricSeams.sql = sqlQueryRunner({
    run: {
      executor: createPgRqlExecutor(pglitePoolOf(database.client)),
      gate: createRqlGate(),
      observe: async () => {},
    },
    alertGate: createRqlGate(),
  });
});

after(() => database.client.close());

for (const metric of METRICS)
  for (const aggregation of metric.aggregations)
    describe(`${metric.id} ${aggregation}`, () => {
      test("every group-by and bucket", async () => {
        await expectSame(
          groupings(metric).flatMap((dimensions) =>
            shapes(metric).map((shape) => cell(metric, aggregation, dimensions, shape)),
          ),
        );
      });

      if (metric.filterable)
        test("every filter, alone and grouped", async () => {
          const filters: [string, MetricQuery["filters"]][] = [
            ...FILTERS,
            ...(metric.source === "scores"
              ? [
                  ["one scorer", { scorer: { id: PARITY_SCORERS.polite } }] as [
                    string,
                    MetricQuery["filters"],
                  ],
                ]
              : []),
          ];
          await expectSame(
            filters.flatMap(([, filters]) =>
              [[], ["model"], ["service"]].flatMap((dimensions) =>
                shapes(metric).map((shape) =>
                  cell(metric, aggregation, dimensions as Dimension[], shape, filters),
                ),
              ),
            ),
          );
        });

      test("every page filter", async () => {
        await expectSame(
          PAGE_FILTERS.flatMap(([, page]) =>
            [[], ...(metric.dimensions.includes("model") ? [["model"]] : [])].flatMap(
              (dimensions) =>
                shapes(metric).map((shape) => ({
                  ...cell(metric, aggregation, dimensions as Dimension[], shape, {
                    // The widget's own filter of a list, under a page filter of it too.
                    ...(metric.filterable ? { agents: ["helper"] } : {}),
                  }),
                  page,
                })),
            ),
          ),
        );
      });
    });

describe("an alert rule reads the same value as RQL, by known time", () => {
  const windows: [string, QueryScope][] = [
    ["an hour with a trace known late", evaluationWindow(60, new Date("2026-11-02T12:30:00Z"))],
    [
      "a day with a trace and a score known after the dashboard's range",
      evaluationWindow(1440, new Date("2026-11-05T03:00:00Z")),
    ],
    ["an empty window", evaluationWindow(60, new Date("2026-11-01T12:00:00Z"))],
  ];
  for (const [name, window] of windows)
    test(name, async () => {
      const failures: string[] = [];
      const empty = name === "an empty window";
      for (const metric of METRICS)
        for (const aggregation of metric.aggregations) {
          const query = metricQuery(metric.id, aggregation);
          const form = await runQuery(PROJECT, query, window, database.db);
          const text = metricAsRql(formOf(query), "number", "hour");
          const rql = await runQuery(
            PROJECT,
            sqlQuery(text),
            { ...window, purpose: "alert" },
            database.db,
          );
          const value = rql.rows[0]?.[0];
          const expected = form.series[0].total;
          if (empty) assert.equal(expected, nothingIsZero(aggregation) ? 0 : null, metric.id);
          const actual = typeof value === "number" ? value : null;
          if (round(expected) !== round(actual))
            failures.push(`${metric.id} ${aggregation}: form ${expected}, RQL ${value}\n${text}`);
          // The same fire and resolve decision, with a threshold on each side of the value.
          for (const threshold of [Math.max(0, (expected ?? 0) - 0.001), (expected ?? 0) + 0.001])
            for (const operator of ["above", "below"] as const)
              for (const current of [
                { state: "ok", firing: false },
                { state: "alerting", firing: true },
              ] as const) {
                const decide = (measured: number | null) =>
                  nextState(current, { operator, threshold }, { value: measured });
                if (JSON.stringify(decide(expected)) !== JSON.stringify(decide(actual)))
                  failures.push(`${metric.id} ${aggregation}: ${operator} ${threshold} differs`);
              }
          cells += 1;
        }
      assert.deepEqual(failures, []);
    });

  test("the late trace is counted in the window it became known in, not the one it started in", async () => {
    const query = metricQuery("trace_count", "count");
    const text = metricAsRql(formOf(query), "number", "hour");
    const known = evaluationWindow(60, new Date("2026-11-02T12:30:00Z"));
    const rql = await runQuery(
      PROJECT,
      sqlQuery(text),
      { ...known, purpose: "alert" },
      database.db,
    );
    // t6 started on 10-31 and became known at 12:00 on 11-02.
    assert.deepEqual(rql.rows, [[1]]);
  });
});

test("the parity suite covers the whole matrix", () => {
  console.log(`metric and RQL parity: ${cells} cells`);
  assert.ok(cells > 1000, `${cells} cells`);
});

function cell(
  metric: MetricDefinition,
  aggregation: Aggregation,
  dimensions: Dimension[],
  shape: Shape,
  filters: MetricQuery["filters"] = {},
): Cell {
  const kept = dimensions.filter((dimension) => metric.dimensions.includes(dimension));
  return {
    query: metricQuery(metric.id, aggregation, {
      dimensions: kept,
      filters: metric.filterable ? filters : {},
      ...(shape === "total" ? {} : { bucket: shape }),
    }),
    shape,
    page: {},
  };
}

/** No group-by, each dimension, and each pair of them. */
function groupings(metric: MetricDefinition): Dimension[][] {
  const { dimensions } = metric;
  return [
    [],
    ...dimensions.map((dimension) => [dimension]),
    ...dimensions.flatMap((first, index) =>
      dimensions.slice(index + 1).map((second) => [first, second]),
    ),
  ];
}

function shapes(metric: MetricDefinition): Shape[] {
  return [...metric.buckets, "total"];
}

/** Runs each cell both ways and fails with every cell that differs. */
async function expectSame(list: readonly Cell[]): Promise<void> {
  const failures: string[] = [];
  for (const { query, shape, page } of list) {
    const scope: QueryScope = { ...PARITY_WINDOW, filter: page };
    const chart: MetricChartKind =
      shape !== "total" ? "line" : query.dimensions.length > 0 ? "table" : "number";
    const text = metricAsRql(formOf(query), chart, shape === "total" ? "hour" : shape);
    const form = await runQuery(PROJECT, query, scope, database.db);
    const rql = await runQuery(PROJECT, sqlQuery(text), scope, database.db);
    const expected = formValues(form, shape);
    const actual = rqlValues(rql, query, shape);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      failures.push(
        `${JSON.stringify({ query: { ...query, version: undefined, kind: undefined }, shape, page })}\nform ${JSON.stringify(expected)}\nRQL  ${JSON.stringify(actual)}\n${text}`,
      );
    cells += 1;
  }
  assert.deepEqual(failures, []);
}

/** The form's numbers by group: each bucket for a series, the total for a number or a table. */
function formValues(result: MetricResult, shape: Shape): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const { groups, total, values: series } of result.series) {
    const key = groups
      .flatMap(({ value, label }) => (label ? [value, label] : [value]))
      .join(" | ");
    values[key] = shape === "total" ? round(total) : series.map(round);
  }
  return sorted(values);
}

/** The text's numbers by group, as the console draws them. */
function rqlValues(result: SqlResult, query: MetricQuery, shape: Shape): Record<string, unknown> {
  const [{ aggregation }] = query.measures;
  if (shape !== "total") {
    const drawn = sqlAsMetric(result, {
      window: PARITY_WINDOW,
      bucket: shape,
      nothing: nothingIsZero(aggregation) ? 0 : null,
    });
    assert.ok(drawn, "drawn as a chart");
    return sorted(
      Object.fromEntries(
        drawn.series.map(({ groups, values }) => [
          groups.map(({ value }) => value).join(" | "),
          values.map(round),
        ]),
      ),
    );
  }
  const values: Record<string, unknown> = {};
  for (const row of result.rows) {
    const value = row[row.length - 1];
    values[row.slice(0, -1).map(String).join(" | ")] = round(
      typeof value === "number" ? value : null,
    );
  }
  // No group-by gives one row, as the form gives one series.
  return sorted(values);
}

function sqlQuery(text: string): SqlQuery {
  return { version: QUERY_VERSION, kind: "sql", text, rqlVersion: RQL_VERSION };
}

function sorted(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1e9) / 1e9;
}
