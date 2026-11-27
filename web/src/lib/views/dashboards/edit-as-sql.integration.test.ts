import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { metricQuery } from "@/lib/contracts/query";
import { getMetric, metricBucket, type QueryScope } from "@/lib/synthesis/metrics/catalog";
import {
  type MetricResult,
  metricSeams,
  runQuery,
  type SqlResult,
} from "@/lib/synthesis/metrics/query";
import { PROJECT, traceDatabase } from "@/lib/synthesis/metrics/trace-fixture";
import { createPgRqlExecutor } from "@/lib/synthesis/rql/adapters/pg-executor";
import { RQL_VERSION } from "@/lib/synthesis/rql/compile";
import { sqlQueryRunner } from "@/lib/synthesis/rql/query";
import { createRqlGate } from "@/lib/synthesis/rql/run";
import { pglitePoolOf } from "@/lib/synthesis/rql/tests/test-support";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import { loadWidget } from "@/lib/views/dashboards/data";
import { metricAsRql } from "@/lib/views/dashboards/edit-as-sql";
import type { MetricWidget } from "@/lib/views/dashboards/types";
import { sqlWidgetQuery } from "@/lib/views/dashboards/widget";
import "@/lib/views/scorers/metrics";

/**
 * `Edit as SQL` gives the numbers of the form: each widget runs as a metric query and as the RQL
 * text `metricAsRql` makes of it, on one database, and both give the same values.
 */

const SCOPE: QueryScope = {
  since: new Date("2026-11-01T00:00:00Z"),
  until: new Date("2026-11-04T00:00:00Z"),
};
const POLITE = "5f0e8a39-6f0e-4a8e-9c5c-0e4a1f1b0001";
const DEPTH = "5f0e8a39-6f0e-4a8e-9c5c-0e4a1f1b0002";

let database: Awaited<ReturnType<typeof traceDatabase>>;

before(async () => {
  database = await traceDatabase();
  const root = (service: string, environment: string, durationMs: number) => ({
    durationMs,
    serviceName: service,
    attributes: { "deployment.environment.name": environment },
  });
  const call = (model: string, input: number, output: number, cost: string) => ({
    model,
    spanClass: "llm",
    inputTokens: input,
    outputTokens: output,
    costUsd: cost,
  });
  await database.seed([
    {
      id: "t1",
      startedAt: "2026-11-02T09:10:00Z",
      root: root("api", "prod", 100),
      spans: [call("gpt-4o", 100, 20, "0.010000"), { tool: "search" }],
    },
    {
      id: "t2",
      startedAt: "2026-11-02T09:40:00Z",
      root: root("api", "prod", 900),
      spans: [call("gpt-4o", 300, 50, "0.030000"), { tool: "read", statusCode: 2 }],
    },
    {
      id: "t3",
      startedAt: "2026-11-02T11:00:00Z",
      root: root("worker", "staging", 300),
      spans: [call("claude", 50, 10, "0.002000")],
    },
    {
      id: "t4",
      startedAt: "2026-11-03T08:00:00Z",
      root: root("worker", "prod", 700),
      spans: [call("claude", 80, 40, "0.004000"), { tool: "search" }],
    },
  ]);
  await database.client.exec(`
    insert into trace_scorers (id, project_id, name, kind, config, created_by, updated_by) values
      ('${POLITE}', '${PROJECT}', 'Polite', 'judge', '{}', 'a', 'a'),
      ('${DEPTH}', '${PROJECT}', 'Depth', 'judge', '{}', 'a', 'a');
    insert into trace_scores (project_id, scorer_id, trace_id, value, passed, trace_started_at) values
      ('${PROJECT}', '${POLITE}', 't1', 1, true, '2026-11-02T09:10:00Z'),
      ('${PROJECT}', '${POLITE}', 't2', 0, false, '2026-11-02T09:40:00Z'),
      ('${PROJECT}', '${DEPTH}', 't1', 5, null, '2026-11-02T09:10:00Z'),
      ('${PROJECT}', '${DEPTH}', 't2', 2, null, '2026-11-02T09:40:00Z'),
      ('${PROJECT}', '${DEPTH}', 't4', 4, null, '2026-11-03T08:00:00Z');
  `);
  metricSeams.sql = sqlQueryRunner({
    run: {
      executor: createPgRqlExecutor(pglitePoolOf(database.client)),
      gate: createRqlGate(),
      observe: async () => {},
    },
  });
});

after(() => database.client.close());

const widget = (
  chart: MetricWidget["chart"],
  ...args: Parameters<typeof metricQuery>
): MetricWidget => ({ title: "", chart, query: metricQuery(...args) });

const SAME_NUMBERS: [string, MetricWidget][] = [
  ["traces by hour", widget("line", "trace_count", "count")],
  [
    "traces by hour and service",
    widget("bar", "trace_count", "count", { dimensions: ["service"] }),
  ],
  ["latency p95 as a number", widget("number", "latency", "p95")],
  [
    "latency p50 by environment",
    widget("table", "latency", "p50", { dimensions: ["environment"] }),
  ],
  ["tokens per trace by hour", widget("line", "tokens", "avg")],
  [
    "cost by service and environment",
    widget("table", "cost", "sum", { dimensions: ["service", "environment"] }),
  ],
  [
    "traces of a model, failed, by day",
    widget("line", "trace_count", "count", {
      filters: { models: ["gpt-4o"], status: "failed" },
      bucket: "day",
    }),
  ],
  [
    "traces of prod and a service, at least 100 tokens",
    widget("number", "trace_count", "count", {
      filters: { environments: ["prod"], minTokens: 100, and: [{ services: ["worker"] }] },
    }),
  ],
  [
    "scorer average by scorer",
    widget("table", "scorer_average", "avg", { dimensions: ["scorer"] }),
  ],
  [
    "results of one scorer by hour",
    widget("line", "scorer_count", "count", { filters: { scorer: { id: POLITE } } }),
  ],
  [
    "scorer average of prod",
    widget("number", "scorer_average", "avg", { filters: { environments: ["prod"] } }),
  ],
];

/** Page filters of a dashboard or of Explore: the form and the text must read the same traces. */
const PAGE_FILTERS: [string, TraceFilter][] = [
  ["no page filter", {}],
  ["the page filter environments=[prod]", { environments: ["prod"] }],
  [
    "a page filter of a model, a service and a minimum of tokens",
    { models: ["claude"], services: ["worker"], minTokens: 100 },
  ],
  [
    "a page filter with a clause on lists and a status",
    { status: "failed", and: [{ tools: ["read", "search"] }] },
  ],
];

for (const [filterName, filter] of PAGE_FILTERS)
  describe(`Edit as SQL gives the numbers of the form, with ${filterName}`, () => {
    const scope: QueryScope = { ...SCOPE, filter };
    for (const [name, input] of SAME_NUMBERS) {
      test(name, async () => {
        const bucket = input.query.bucket ?? metricBucket(metricOf(input), SCOPE);
        const rql = metricAsRql(input, bucket);
        assert.ok(rql.ok, JSON.stringify(rql));
        const form = await runQuery(PROJECT, input.query, scope, database.db);
        // The sql widget as a dashboard reads it: through `loadWidget`, with the page's filter.
        const text = await loadWidget(
          PROJECT,
          { title: "", chart: "sql", query: sqlWidgetQuery(rql.text) },
          scope,
          database.db as never,
        );
        assert.ok(text?.kind === "sql", JSON.stringify(text));
        const expected = formValues(form, input);
        if (Object.keys(filter).length === 0)
          assert.ok(expected.size > 0, "the fixture gives the widget numbers");
        assert.deepEqual(textValues(text), expected, rql.text);
      });
    }
  });

test("the checker's case: a trace count under environments=[prod] is the same number after Edit as SQL", async () => {
  const input = widget("number", "trace_count", "count");
  const scope: QueryScope = { ...SCOPE, filter: { environments: ["prod"] } };
  const rql = metricAsRql(input, "hour");
  assert.ok(rql.ok);
  const form = await runQuery(PROJECT, input.query, scope, database.db);
  const text = await loadWidget(
    PROJECT,
    { title: "", chart: "sql", query: sqlWidgetQuery(rql.text) },
    scope,
    database.db as never,
  );
  assert.equal(form.series[0].total, 3);
  assert.deepEqual(text?.kind === "sql" && text.rows, [[3]]);
});

describe("what has no RQL form gives its reason", () => {
  for (const [name, input] of [
    ["a rate", widget("line", "error_rate", "rate")],
    ["a group-by model", widget("table", "trace_count", "count", { dimensions: ["model"] })],
    ["a context metric", widget("line", "context_tokens", "sum")],
    ["a group-by tool", widget("table", "trace_count", "count", { dimensions: ["tool"] })],
    ["a group-by agent", widget("table", "trace_count", "count", { dimensions: ["agent"] })],
    ["a scorer pass rate", widget("line", "scorer_pass_rate", "rate")],
    [
      "a trace filter on scorer results",
      widget("line", "scorer_count", "count", { filters: { status: "failed" } }),
    ],
  ] as const) {
    test(name, () => {
      const rql = metricAsRql(input, "hour");
      assert.equal(rql.ok, false);
      assert.ok(!rql.ok && rql.reason.length > 0);
    });
  }
});

function metricOf({ query }: MetricWidget) {
  const metric = getMetric(query.measures[0].measure);
  assert.ok(metric);
  return metric;
}

/** Each value of the form, by bucket and groups: the totals for a number or a table. */
function formValues(result: MetricResult, { chart }: MetricWidget): Map<string, number> {
  const values = new Map<string, number>();
  const timed = chart === "line" || chart === "bar";
  for (const { groups, total, values: series } of result.series) {
    const group = groups.map(({ value }) => value);
    if (!timed) {
      if (total !== null) values.set(key([...group]), round(total));
      continue;
    }
    series.forEach((value, index) => {
      if (value !== null && value !== 0)
        values.set(key([result.buckets[index], ...group]), round(value));
    });
  }
  return values;
}

/** The rows of the text, by every column but the last, which is the value. */
function textValues(result: SqlResult): Map<string, number> {
  const values = new Map<string, number>();
  const timed = result.columns[0]?.name === "bucket";
  // A group-by scorer gives the id and the name: the form's group is the id.
  const named = result.columns.some(({ name }) => name === "scorer");
  for (const row of result.rows) {
    const value = row[row.length - 1];
    // A bucket without rows is no row of the text: a zero of a timed series is left out on both sides.
    if (value === null || (timed && value === 0)) continue;
    const parts = row
      .slice(0, -1)
      .filter((_, index) => !named || result.columns[index].name !== "scorer")
      .map((part, index) =>
        timed && index === 0 ? new Date(String(part)).toISOString() : String(part),
      );
    values.set(key(parts), round(Number(value)));
  }
  return values;
}

function key(parts: readonly string[]): string {
  return parts.join(" | ");
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
