import assert from "node:assert/strict";
import { test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildWidgetQuery, DAY_GROUP_LIMIT } from "./query";
import {
  chartFitsGroupBy,
  MAX_TOP_N,
  RETENTION_DAYS,
  validateWidgetSpec,
  WIDGET_CHARTS,
  WIDGET_FIXED_GROUP_BYS,
  WIDGET_METRICS,
  WIDGET_RANGE_DAYS,
  type WidgetGroupBy,
  type WidgetSpec,
} from "./spec";

/** RC-887: the widget spec whitelist. */

const PIVOTS = [
  { key: "client", presetId: "client" },
  { key: "session", presetId: "session" },
  { key: "end_user", presetId: "end_user" },
];
const CONTEXT = { pivots: PIVOTS };
const BASE = { metric: "runs", groupBy: null, filter: {}, chart: "kpi", rangeDays: 7 };
const PROJECT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-18T12:00:00Z");

test("every whitelisted metric, group-by, chart and range combination that fits is accepted", () => {
  const groupBys: (WidgetGroupBy | null)[] = [null, ...WIDGET_FIXED_GROUP_BYS, "pivot:client"];
  let accepted = 0;
  for (const metric of WIDGET_METRICS)
    for (const groupBy of groupBys)
      for (const chart of WIDGET_CHARTS)
        for (const rangeDays of WIDGET_RANGE_DAYS) {
          const result = validateWidgetSpec(
            { metric, groupBy, chart, rangeDays, filter: {} },
            CONTEXT,
          );
          if (chartFitsGroupBy(chart, groupBy)) {
            assert.ok(result.ok, `${metric} ${groupBy} ${chart} ${rangeDays}`);
            accepted += 1;
          } else {
            assert.deepEqual(result, { ok: false, error: "chart_group_by_mismatch" });
          }
        }
  assert.ok(accepted > 0);
});

test("a full filter and a top N are kept", () => {
  const filter = {
    models: ["gpt"],
    tools: ["search"],
    services: ["api"],
    environments: ["prod"],
    agents: ["a"],
    mcpServers: ["m"],
    status: "failed",
    minCostUsd: 0.5,
    minTokens: 10,
  };
  const result = validateWidgetSpec(
    { ...BASE, chart: "table", groupBy: "model", filter, topN: 5 },
    CONTEXT,
  );
  assert.deepEqual(result, {
    ok: true,
    spec: { ...BASE, chart: "table", groupBy: "model", filter, topN: 5 },
  });
});

test("a day grouping drops the top N: a time series has no Other, the range caps it", () => {
  const result = validateWidgetSpec(
    { ...BASE, chart: "table", groupBy: "day", rangeDays: 30, topN: 1 },
    CONTEXT,
  );
  assert.deepEqual(result, {
    ok: true,
    spec: { ...BASE, chart: "table", groupBy: "day", rangeDays: 30 },
  });
  assert.deepEqual(
    validateWidgetSpec({ ...BASE, chart: "line", groupBy: "day", topN: 0 }, CONTEXT),
    { ok: false, error: "invalid_top_n" },
  );
});

test("the day query has an explicit limit of the dates the longest range touches, and ignores a top N", () => {
  const dialect = new PgDialect();
  const day: WidgetSpec = {
    metric: "runs",
    groupBy: "day",
    chart: "line",
    rangeDays: 30,
    filter: {},
  };
  const plain = buildWidgetQuery(PROJECT, day, [], NOW);
  const withTopN = buildWidgetQuery(PROJECT, { ...day, topN: 1 }, [], NOW);
  assert.ok(plain.ok && withTopN.ok);
  const a = dialect.sqlToQuery(plain.query);
  const b = dialect.sqlToQuery(withTopN.query);
  const limit = /limit \$(\d+)\s*$/.exec(a.sql);
  assert.ok(limit, "the day query ends with a bound limit");
  assert.equal(a.params[Number(limit[1]) - 1], DAY_GROUP_LIMIT);
  assert.equal(DAY_GROUP_LIMIT, RETENTION_DAYS + 1, "a rolling 30-day window touches 31 UTC dates");
  assert.equal(
    RETENTION_DAYS,
    Math.max(...WIDGET_RANGE_DAYS),
    "the limit is the longest range the validator accepts",
  );
  assert.deepEqual(b, a, "a top N changes nothing for a day grouping");
});

test("unknown metrics, group-bys and charts are rejected", () => {
  assert.deepEqual(validateWidgetSpec({ ...BASE, metric: "revenue" }, CONTEXT), {
    ok: false,
    error: "unknown_metric",
  });
  assert.deepEqual(validateWidgetSpec({ ...BASE, chart: "table", groupBy: "country" }, CONTEXT), {
    ok: false,
    error: "unknown_group_by",
  });
  assert.deepEqual(validateWidgetSpec({ ...BASE, chart: "table", groupBy: "pivot:a b" }, CONTEXT), {
    ok: false,
    error: "unknown_group_by",
  });
  assert.deepEqual(validateWidgetSpec({ ...BASE, chart: "pie" }, CONTEXT), {
    ok: false,
    error: "unknown_chart",
  });
});

test("a pivot key the project has not configured is rejected", () => {
  assert.deepEqual(
    validateWidgetSpec({ ...BASE, chart: "bar", groupBy: "pivot:tenant.id" }, CONTEXT),
    {
      ok: false,
      error: "unconfigured_pivot",
    },
  );
  assert.deepEqual(
    validateWidgetSpec({ ...BASE, chart: "bar", groupBy: "pivot:client" }, { pivots: [] }),
    {
      ok: false,
      error: "unconfigured_pivot",
    },
  );
});

test("a range over the retention window, or not a preset, is rejected", () => {
  assert.deepEqual(validateWidgetSpec({ ...BASE, rangeDays: 31 }, CONTEXT), {
    ok: false,
    error: "range_over_retention",
  });
  assert.deepEqual(validateWidgetSpec({ ...BASE, rangeDays: 90 }, CONTEXT), {
    ok: false,
    error: "range_over_retention",
  });
  assert.deepEqual(validateWidgetSpec({ ...BASE, rangeDays: 3 }, CONTEXT), {
    ok: false,
    error: "invalid_range",
  });
  assert.deepEqual(validateWidgetSpec({ ...BASE, rangeDays: 0 }, CONTEXT), {
    ok: false,
    error: "invalid_range",
  });
  assert.deepEqual(validateWidgetSpec({ ...BASE, rangeDays: "7" }, CONTEXT), {
    ok: false,
    error: "invalid_range",
  });
});

test("extra fields, a bad filter and a top N over the cap are rejected", () => {
  assert.deepEqual(validateWidgetSpec({ ...BASE, sql: "select 1" }, CONTEXT), {
    ok: false,
    error: "invalid_spec",
  });
  assert.deepEqual(validateWidgetSpec("runs", CONTEXT), { ok: false, error: "invalid_spec" });
  assert.deepEqual(validateWidgetSpec({ ...BASE, filter: { where: "1=1" } }, CONTEXT), {
    ok: false,
    error: "invalid_filter",
  });
  assert.deepEqual(validateWidgetSpec({ ...BASE, filter: { models: "gpt" } }, CONTEXT), {
    ok: false,
    error: "invalid_filter",
  });
  assert.deepEqual(validateWidgetSpec({ ...BASE, filter: { status: "maybe" } }, CONTEXT), {
    ok: false,
    error: "invalid_filter",
  });
  assert.deepEqual(
    validateWidgetSpec({ ...BASE, chart: "bar", groupBy: "model", topN: MAX_TOP_N + 1 }, CONTEXT),
    {
      ok: false,
      error: "invalid_top_n",
    },
  );
  assert.deepEqual(
    validateWidgetSpec({ ...BASE, chart: "bar", groupBy: "model", topN: 0 }, CONTEXT),
    { ok: false, error: "invalid_top_n" },
  );
});

test("SQL text in a string field changes no query text: every value is a bound parameter", () => {
  const dialect = new PgDialect();
  const injection = "x'); drop table dashboards; --";
  const spec = (text: string): WidgetSpec => ({
    metric: "distinct_users",
    groupBy: "pivot:client",
    chart: "table",
    rangeDays: 30,
    filter: {
      models: [text],
      tools: [text],
      services: [text],
      environments: [text],
      agents: [text],
      mcpServers: [text],
    },
  });
  const pivots = (key: string) => [
    { key, presetId: "client" },
    { key: `${key}-user`, presetId: "end_user" },
  ];
  const plain = buildWidgetQuery(
    PROJECT,
    { ...spec("gpt"), groupBy: "pivot:client" },
    pivots("client"),
    NOW,
  );
  const hostile = buildWidgetQuery(
    PROJECT,
    { ...spec(injection), groupBy: `pivot:${injection}` as WidgetGroupBy },
    pivots(injection),
    NOW,
  );
  assert.ok(plain.ok && hostile.ok);
  const a = dialect.sqlToQuery(plain.query);
  const b = dialect.sqlToQuery(hostile.query);
  assert.equal(b.sql, a.sql, "the query text does not depend on the values");
  assert.ok(!b.sql.includes("drop table"));
  assert.ok(b.params.includes(injection), "the hostile text is a parameter");
});
