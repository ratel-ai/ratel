import assert from "node:assert/strict";
import { test } from "node:test";
import type { MetricResult } from "@/lib/synthesis/metrics/query";
import { RQL_LIMITS } from "@/lib/synthesis/rql/compile";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import { traceFilterFromSearch } from "@/lib/synthesis/traces/v2/filters";
import {
  axisTicks,
  chartModel,
  formatMetric,
  formatMetricExact,
  isEmptyResult,
  lineSegments,
} from "@/lib/views/dashboards/chart-model";
import { loadWidgets } from "@/lib/views/dashboards/data";
import { searchFromTraceFilter, widgetTracesHref } from "@/lib/views/dashboards/links";
import { parseWidget } from "@/lib/views/dashboards/parse-widget";
import { TRACES_OVERVIEW_WIDGETS } from "@/lib/views/dashboards/templates/traces-overview";
import type { MetricWidget } from "@/lib/views/dashboards/types";

const FILTER: TraceFilter = {
  models: ["gpt-4o", "a&b"],
  tools: ["lookup order"],
  services: ["support"],
  environments: ["prod"],
  agents: ["planner"],
  mcpServers: ["orders"],
  status: "failed",
  minCostUsd: 0.1,
  minTokens: 1000,
};

test("a filter survives the filter bar's query string", () => {
  assert.deepEqual(
    traceFilterFromSearch(searchFromTraceFilter(FILTER), { entities: true }),
    FILTER,
  );
  assert.equal(searchFromTraceFilter({}), "");
});

test("View traces carries the widget's filter and the time range", () => {
  const preset = new URL(
    widgetTracesHref("p1", FILTER, { preset: "30d", from: "", to: "" }),
    "https://x",
  );
  assert.equal(preset.pathname, "/project/p1/traces/turns");
  assert.equal(preset.searchParams.get("range"), "30d");
  assert.deepEqual(traceFilterFromSearch(preset.search, { entities: true }), FILTER);

  const custom = widgetTracesHref(
    "p1",
    { models: ["a", "b"] },
    { preset: "custom", from: "2026-11-01", to: "2026-11-02" },
    [{ by: "model", value: "b" }],
  );
  assert.equal(
    custom,
    "/project/p1/traces/turns?facetModel=b&range=custom&from=2026-11-01&to=2026-11-02",
  );
});

test("View traces keeps a property filter, and a group of a property, user or session (RTL-397)", () => {
  const filter: TraceFilter = { properties: { plan: ["pro"] }, withoutProperties: ["release"] };
  const href = new URL(
    widgetTracesHref("p1", filter, { preset: "7d", from: "", to: "" }, [
      { by: { property: "org" }, value: "acme" },
      { by: "user", value: "u1" },
    ]),
    "https://x",
  );
  assert.deepEqual(traceFilterFromSearch(href.search, { entities: true }), {
    users: ["u1"],
    properties: { plan: ["pro"], org: ["acme"] },
    withoutProperties: ["release"],
  });
});

test("stacked bars scale to their total; lines scale to their peak", () => {
  const result = grouped([
    ["b", [3, 1]],
    ["a", [2, 0]],
  ]);
  const bars = chartModel(result, "sum", "tokens", "bar");
  assert.equal(bars.stacked, true);
  assert.equal(bars.scaleMax, 5);
  assert.equal(chartModel(result, "sum", "tokens", "line").scaleMax, 5);
  assert.equal(chartModel(result, "p95", "ms", "bar").stacked, false);
  // Colors follow the group's name, not its rank.
  assert.deepEqual(
    bars.series.map((series) => [series.label, series.slot]),
    [
      ["b", 2],
      ["a", 1],
    ],
  );
});

test("past six groups: the rest is Other when it adds up, and is said when it does not", () => {
  const result = grouped(Array.from({ length: 8 }, (_, index) => [`g${index}`, [8 - index, 1]]));
  const sum = chartModel(result, "sum", "usd", "bar");
  assert.deepEqual(sum.series.at(-1), {
    key: "\u0000other",
    label: "Other",
    slot: null,
    values: [3, 2],
  });
  assert.equal(sum.note, null);
  const p95 = chartModel(result, "p95", "ms", "line");
  assert.equal(p95.series.length, 6);
  assert.match(p95.note ?? "", /6 highest of 8/);
});

test("a rate's axis ends at 100%", () => {
  assert.equal(chartModel(grouped([["a", [1]]]), "rate", "ratio", "line").scaleMax, 1);
  assert.equal(chartModel(grouped([["a", [0.3]]]), "rate", "ratio", "line").scaleMax, 0.5);
});

test("a result with no samples is empty", () => {
  assert.equal(isEmptyResult({ kind: "metric", bucket: "day", buckets: [], series: [] }), true);
  const zero = grouped([["a", [0, 0]]]);
  assert.equal(isEmptyResult(zero), false, "a real zero is drawn");
  zero.series[0].samples = 0;
  assert.equal(isEmptyResult(zero), true);
});

test("a line breaks where there is nothing to read", () => {
  assert.deepEqual(lineSegments([1, 2, null, 0, null]), [[0, 1], [3]]);
});

test("axis labels: hours in a day, days otherwise, never more than asked", () => {
  const hours = Array.from({ length: 24 }, (_, hour) =>
    new Date(Date.UTC(2026, 10, 2, hour)).toISOString(),
  );
  assert.equal(axisTicks(hours, "hour", 4)[1].label, "06:00");
  const days = Array.from({ length: 30 }, (_, day) =>
    new Date(Date.UTC(2026, 10, 1 + day)).toISOString(),
  );
  assert.ok(axisTicks(days, "day", 5).length <= 5);
  assert.equal(axisTicks(days, "day", 5)[0].label, "Nov 1");
});

test("numbers read by their unit, exact in tables", () => {
  assert.equal(formatMetric(12_400, "tokens"), "12.4K");
  assert.equal(formatMetricExact(12_400, "tokens"), "12,400");
  assert.equal(formatMetric(0.034, "ratio"), "3.4%");
  assert.equal(formatMetric(3.2, "usd"), "$3.20");
  assert.equal(formatMetric(null, "ms"), "–");
});

test("widgets load in order, a few at a time, and a failed one leaves the rest", async () => {
  let running = 0;
  let most = 0;
  const widgets = Array.from({ length: 10 }, (_, index) => ({
    ...TRACES_OVERVIEW_WIDGETS[0],
    title: String(index),
  }));
  const results = await loadWidgets(
    "p1",
    widgets,
    { since: new Date(0), until: new Date(1) },
    async (_, widget) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return widget.title === "3" ? null : grouped([[widget.title, [1]]]);
    },
  );
  // A metric widget is RQL: it reads as many at once as the console's RQL gate gives.
  assert.equal(most, RQL_LIMITS.parallelConsoleQueriesPerProject);
  assert.deepEqual(
    results.map((result) => (result as MetricResult | null)?.series[0].groups[0].value ?? null),
    ["0", "1", "2", null, "4", "5", "6", "7", "8", "9"],
  );
});

test("a scorer average is drawn on its 1 to 5 scale, named after the scorer", () => {
  const result = grouped([["id-1", [2.456]]]);
  result.series[0].groups = [{ value: "id-1", label: "Depth" }];
  const model = chartModel(result, "avg", "score", "line");
  assert.equal(model.scaleMax, 5);
  assert.deepEqual([model.series[0].key, model.series[0].label], ["id-1", "Depth"]);
  assert.equal(formatMetric(2.456, "score"), "2.46");
});

function grouped(series: [string, number[]][]): MetricResult {
  return {
    kind: "metric",
    bucket: "day",
    buckets: series[0][1].map((_, index) => new Date(Date.UTC(2026, 10, 1 + index)).toISOString()),
    series: series.map(([group, values]) => ({
      groups: [{ value: group }],
      total: 1,
      samples: 1,
      values,
    })),
  };
}

test("a query of kind sql is drawn as a line, a bar, a number or a table", () => {
  const query = { version: 1, kind: "sql", text: "select count(*) from traces", rqlVersion: 1 };
  for (const chart of ["line", "bar", "number", "table"])
    assert.deepEqual(parseWidget({ title: "", query, chart }), {
      ok: true,
      widget: { title: "", query, chart },
    });
  for (const chart of ["flow", "funnel"])
    assert.deepEqual(parseWidget({ title: "", query, chart }), {
      ok: false,
      error: `A metric cannot be drawn as a ${chart}.`,
    });
});

test("an older widget of chart sql is read as the chart its rows draw", () => {
  const query = { version: 1, kind: "sql", text: "select count(*) from traces", rqlVersion: 1 };
  assert.deepEqual(parseWidget({ title: "", query, chart: "sql" }), {
    ok: true,
    widget: { title: "", query, chart: "table" },
  });
  assert.deepEqual(parseWidget({ title: "", query, chart: "sql" }, { sqlChart: () => "line" }), {
    ok: true,
    widget: { title: "", query, chart: "line" },
  });
});
