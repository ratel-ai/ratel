import assert from "node:assert/strict";
import { test } from "node:test";
import { metricQuery, QUERY_VERSION } from "@/lib/contracts/query";
import type { SqlResult } from "@/lib/synthesis/metrics/query";
import { exportDashboard, importDashboard } from "@/lib/views/dashboards/document";
import { sqlChartOfText } from "@/lib/views/dashboards/legacy-chart";
import {
  formBucketOf,
  formQuery,
  isFormText,
  metricAsRql,
  textToRun,
} from "@/lib/views/dashboards/metric-rql";
import { parseWidget } from "@/lib/views/dashboards/parse-widget";
import { chartChoices, formAsMetric } from "@/lib/views/dashboards/sql-chart";
import { readWidgets, writeWidgets } from "@/lib/views/dashboards/stored-widget";
import { fitWidget, formOf, formWidget, sqlWidgetQuery } from "@/lib/views/dashboards/widget";

/**
 * One metric widget that runs RQL: the stored shape (kind sql with the form's selection), the
 * read of the shapes an older version stored, the chart rule of RQL rows, and the text of a form.
 */

const ON = { customMonitoring: true } as const;
const LAYOUT = { x: 0, y: 0, w: 6, h: 6 };
const SCORER = "5f0e8a39-6f0e-4a8e-9c5c-0e4a1f1b0001";
const LATENCY = metricQuery("latency", "p95", { dimensions: ["model"], filters: { tools: ["a"] } });

test("an old metric widget reads as RQL with its form, the same chart, and saves in the new shape", () => {
  const stored = [{ id: "w1", title: "Speed", query: LATENCY, chart: "line", layout: LAYOUT }];
  const [widget] = readWidgets(stored);
  assert.deepEqual(widget, {
    id: "w1",
    title: "Speed",
    chart: "line",
    layout: LAYOUT,
    query: {
      version: QUERY_VERSION,
      kind: "sql",
      text: metricAsRql(formOf(LATENCY), "line", "hour"),
      rqlVersion: 1,
      form: formOf(LATENCY),
    },
  });
  // Written back, it is the new shape, and it reads back the same.
  const written = writeWidgets([widget]);
  assert.equal((written[0] as { query: { kind: string } }).query.kind, "sql");
  assert.deepEqual(readWidgets(written), [widget]);
});

test("an old metric table without a group-by and an old number keep their chart", () => {
  for (const chart of ["table", "number", "bar"] as const) {
    const parsed = parseWidget(
      { title: "", query: metricQuery("trace_count", "count"), chart },
      ON,
    );
    assert.ok(parsed.ok, chart);
    assert.equal(parsed.widget.chart, chart);
    assert.equal(parsed.widget.query.kind, "sql");
  }
});

test("an old sql widget of chart sql draws as a line when its rows have one time column, else a table", () => {
  const timed =
    "select time_bucket('1 hour', started_at) as hour, count(*) from traces group by hour";
  const table = "select trace_id, duration_ms from traces";
  const read = (text: string) =>
    readWidgets(
      [{ id: "w", title: "", chart: "sql", query: sqlWidgetQuery(text), layout: LAYOUT }],
      {
        sqlChart: sqlChartOfText,
      },
    )[0];
  assert.deepEqual(read(timed), {
    id: "w",
    title: "",
    chart: "line",
    query: sqlWidgetQuery(timed),
    layout: LAYOUT,
  });
  assert.equal((read(table) as { chart: string }).chart, "table");
  // Without the compiler (the browser), an old one is a table.
  const parsed = parseWidget({ title: "", chart: "sql", query: sqlWidgetQuery(timed) }, ON);
  assert.ok(parsed.ok && parsed.widget.chart === "table");
});

test("a form whose text is not its own any more is Custom", () => {
  const query = {
    ...formQuery(formOf(LATENCY), "line", "hour"),
    text: "select count(*) from traces",
  };
  const parsed = parseWidget({ title: "", chart: "line", query }, ON);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.widget.query, sqlWidgetQuery("select count(*) from traces"));
});

test("the text of a selection is recognised for either bucket and any spacing; an edited text is Custom", () => {
  const form = formOf(LATENCY);
  const hourly = formQuery(form, "line", "hour");
  const daily = formQuery(form, "line", "day");
  assert.equal(formBucketOf(hourly, "line"), "hour");
  assert.equal(formBucketOf(daily, "line"), "day");
  assert.equal(
    isFormText({ ...hourly, text: hourly.text.replaceAll("\n", "   \n ") }, "line"),
    true,
  );
  assert.equal(isFormText({ ...hourly, text: `${hourly.text} limit 5` }, "line"), false);
  assert.equal(isFormText(hourly, "number"), false, "a number's text has no bucket");
  assert.equal(isFormText(sqlWidgetQuery(hourly.text), "line"), false, "no form is Custom");
});

test("a text of the form follows the window; a Custom text runs as written", () => {
  const form = formOf(metricQuery("trace_count", "count"));
  const query = formQuery(form, "line", "hour");
  const days = (count: number) => ({
    since: new Date("2026-11-01T00:00:00Z"),
    until: new Date(Date.parse("2026-11-01T00:00:00Z") + count * 86_400_000),
  });
  assert.match(textToRun(query, "line", days(2)), /'1 hour'/);
  assert.match(textToRun(query, "line", days(30)), /'1 day'/);
  const custom = sqlWidgetQuery(
    "select time_bucket('1 hour', started_at) as h, count(*) from traces group by h",
  );
  assert.equal(textToRun(custom, "line", days(30)), custom.text);
});

test("the editor writes the text of the selection again after each change", () => {
  const widget = formWidget(formOf(LATENCY), "line");
  const number = fitWidget({ ...widget, chart: "number" });
  assert.equal(number.query.kind === "sql" && number.query.form?.dimensions.length, 0);
  assert.ok(number.query.kind === "sql" && isFormText(number.query, "number"));
  assert.doesNotMatch(number.query.kind === "sql" ? number.query.text : "", /time_bucket/);
});

const result = (columns: [string, string][], rows: unknown[][] = [[]]): SqlResult => ({
  kind: "sql",
  columns: columns.map(([name, type]) => ({ name, type })),
  rows,
  truncated: false,
});

test("the chart rule: a table of traces is a table only, with the reasons", () => {
  const traces = result(
    [
      ["trace_id", "text"],
      ["started_at", "timestamp"],
      ["has_error", "boolean"],
      ["models", "text_list"],
    ],
    [[], []],
  );
  assert.deepEqual(chartChoices(traces), {
    table: null,
    line: "A chart needs a number column, as count(*) or sum(...) gives.",
    bar: "A chart needs a number column, as count(*) or sum(...) gives.",
    number: "A number needs one number column: the rows have 0.",
  });
});

test("the chart rule: one number is a number or a table", () => {
  assert.deepEqual(chartChoices(result([["traces", "integer"]], [[3]])), {
    table: null,
    line: "A line needs one time column, as time_bucket(...) gives.",
    bar: "A bar needs a time column or a text column for its bars.",
    number: null,
  });
});

test("the chart rule: a time series is a line or a bar; a grouped one too, with one number", () => {
  const series = result(
    [
      ["hour", "timestamp"],
      ["traces", "integer"],
    ],
    [[], []],
  );
  assert.deepEqual(chartChoices(series), {
    table: null,
    line: null,
    bar: null,
    number: "A number needs one row: the query gives 2.",
  });
  const grouped = result(
    [
      ["hour", "timestamp"],
      ["model", "text"],
      ["traces", "integer"],
    ],
    [[], []],
  );
  assert.equal(chartChoices(grouped).line, null);
  const two = result([
    ["hour", "timestamp"],
    ["model", "text"],
    ["traces", "integer"],
    ["cost", "number"],
  ]);
  assert.equal(chartChoices(two).line, "With a series column, a chart draws one number column.");
});

test("the chart rule: a text grouping is a bar, not a line", () => {
  const byModel = result(
    [
      ["model", "text"],
      ["traces", "integer"],
    ],
    [[], []],
  );
  assert.deepEqual(chartChoices(byModel), {
    table: null,
    line: "A line needs one time column, as time_bucket(...) gives.",
    bar: null,
    number: "A number needs one row: the query gives 2.",
  });
  const series = result([
    ["model", "text"],
    ["tool", "text"],
    ["service", "text"],
    ["traces", "integer"],
  ]);
  assert.equal(
    chartChoices(series).bar,
    "A chart reads one text column as its series: the rows have 2.",
  );
});

test("a dashboard exports a metric widget with its scorer by name, and imports it into another project", () => {
  const form = formOf(
    metricQuery("scorer_average", "avg", { filters: { scorer: { id: SCORER } } }),
  );
  const widget = { ...formWidget(form, "line"), id: "w", layout: LAYOUT };
  const document = exportDashboard({ name: "Board", filters: {}, range: null, widgets: [widget] }, [
    { id: SCORER, name: "Depth" },
  ]);
  const [exported] = document.widgets;
  assert.equal(exported.query.kind, "sql");
  const text = exported.query.kind === "sql" ? exported.query.text : "";
  assert.ok(!text.includes(SCORER), "no database id leaves");
  assert.match(text, /scorer = 'Depth'/);
  const other = "6f0e8a39-6f0e-4a8e-9c5c-0e4a1f1b0009";
  const imported = importDashboard(JSON.parse(JSON.stringify(document)), {
    scorers: [{ id: other, name: "Depth", verdict: false }],
    features: ON,
  });
  assert.ok(imported.ok, JSON.stringify(imported));
  const [back] = imported.dashboard.widgets;
  const expected = formWidget(
    formOf(metricQuery("scorer_average", "avg", { filters: { scorer: { id: other } } })),
    "line",
  );
  assert.deepEqual(back.query, expected.query);
  assert.deepEqual(imported.dashboard.missingScorers, []);
});

test("an old dashboard document imports in the new shape", () => {
  const imported = importDashboard(
    {
      type: "ratel.dashboard",
      version: 1,
      name: "Old",
      widgets: [
        { chart: "number", query: metricQuery("trace_count", "count"), layout: LAYOUT },
        {
          chart: "sql",
          query: sqlWidgetQuery(
            "select time_bucket('1 day', started_at) as d, count(*) from traces group by d",
          ),
          layout: { ...LAYOUT, x: 6 },
        },
      ],
    },
    { scorers: [], features: ON },
  );
  assert.ok(imported.ok, JSON.stringify(imported));
  const [number, sql] = imported.dashboard.widgets;
  assert.deepEqual(
    number.query,
    formQuery(formOf(metricQuery("trace_count", "count")), "number", "hour"),
  );
  assert.equal(sql.chart, "line");
  assert.equal(sql.query.kind === "sql" && sql.query.form, undefined);
});

test("an old metric whose RQL text would pass the limit stays as stored, a broken entry with the reason", () => {
  const tools = Array.from({ length: 60 }, (_, index) => `tool_${index}_${"x".repeat(14)}`);
  const long = metricQuery("cost", "sum", { dimensions: ["tool"], filters: { tools } });
  const stored = [{ id: "w1", title: "Cost", query: long, chart: "line", layout: LAYOUT }];
  const [read] = readWidgets(stored);
  assert.ok("problem" in read, JSON.stringify(read).slice(0, 200));
  assert.match(read.problem, /4,000 characters/);
  // A save of the dashboard writes it back as it was: the metric is not lost.
  assert.deepEqual(writeWidgets([read]), stored);
  // The same refusal at the boundary: an import or an MCP change of it is refused with the reason.
  const parsed = parseWidget({ title: "", query: long, chart: "line" }, ON);
  assert.ok(!parsed.ok && /4,000 characters/.test(parsed.error));
});

test("a property of the form is properties['name'] in the text: its filter, its group, its column", () => {
  const form = formOf(
    metricQuery("latency", "p95", {
      dimensions: [{ property: "org.id" }, "user"],
      filters: {
        properties: { plan: ["pro", "o'brien"] },
        and: [{ properties: { "org.id": ["a"] } }],
      },
    }),
  );
  assert.equal(
    metricAsRql(form, "table", "day"),
    [
      "select properties['org.id'] as org_id, user_id, p95(duration_ms) as value",
      "from traces",
      "where properties['org.id'] is not null",
      "  and user_id is not null",
      "  and properties['plan'] in ('pro', 'o''brien')",
      "  and properties['org.id'] in ('a')",
      "group by properties['org.id'], user_id",
      "order by value desc",
      "limit 1000",
    ].join("\n"),
  );
  const scores = formOf(
    metricQuery("scorer_count", "count", {
      dimensions: [{ property: "plan" }, "session"],
    }),
  );
  assert.match(metricAsRql(scores, "line", "hour"), /properties\['plan'\] as plan, session_id/);
  // The name of the column is no reserved word and no other output's; GROUP BY names the value.
  const named = formOf(
    metricQuery("trace_count", "count", {
      dimensions: [{ property: "trace_id" }, { property: "trace-id" }],
    }),
  );
  assert.match(
    metricAsRql(named, "table", "day"),
    /properties\['trace_id'\] as trace_id, properties\['trace-id'\] as trace_id_property,[\s\S]*group by properties\['trace_id'\], properties\['trace-id'\]/,
  );
  const reserved = formOf(
    metricQuery("trace_count", "count", {
      dimensions: [{ property: "order" }, { property: "9x" }],
    }),
  );
  assert.match(
    metricAsRql(reserved, "table", "day"),
    /properties\['order'\] as order_property, properties\['9x'\] as property_9x/,
  );
});

test("a group of tasks reads as the task's name where the page knows it (RTL-397)", () => {
  const form = formOf(metricQuery("trace_count", "count", { dimensions: ["task"] }));
  const result: SqlResult = {
    kind: "sql",
    columns: [
      { name: "task", type: "text" },
      { name: "value", type: "integer" },
    ],
    rows: [
      ["wf-1", 3],
      ["wf-gone", 1],
    ],
    truncated: false,
  };
  const window = { since: new Date("2026-11-01"), until: new Date("2026-11-02") };
  const drawn = formAsMetric(result, form, "table", window, {
    taskNames: { "wf-1": "Track a delivery" },
  });
  assert.deepEqual(
    drawn.series.map(({ groups }) => groups[0]),
    [{ value: "wf-1", label: "Track a delivery" }, { value: "wf-gone" }],
  );
});
