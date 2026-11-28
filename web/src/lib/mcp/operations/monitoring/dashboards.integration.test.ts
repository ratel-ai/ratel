import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { z } from "zod";
import { type MetricQuery, querySchema } from "@/lib/contracts/query";
import { dispatchOperation } from "@/lib/mcp/dispatch";
import { buildRegistry } from "@/lib/mcp/registry";
import type { MetricResult } from "@/lib/synthesis/metrics/query";
import { changeDashboard } from "@/lib/views/dashboards/actions";
import { shownFilters } from "@/lib/views/dashboards/filters";
import { metricAsRql } from "@/lib/views/dashboards/metric-rql";
import { resolveWidgetRange } from "@/lib/views/dashboards/range";
import * as store from "@/lib/views/dashboards/store";
import type { MetricChartKind } from "@/lib/views/dashboards/types";
import { formOf, formWidget, metricOfForm } from "@/lib/views/dashboards/widget";
import { decodePanels, PANELS_PARAM } from "@/lib/views/explore/state";
import { loadScorerPicker } from "@/lib/views/scorers/picker";
import { createScorer } from "@/lib/views/scorers/store";
import { checkDraft } from "@/lib/views/scorers/test-support";
import {
  dashboardReadOperations,
  dashboardTemplateOperations,
  dashboardWriteOperations,
  EXAMPLES,
} from "./dashboards";
import { POINT_CAP } from "./results";
import {
  insertTrace,
  KEY_AUTH,
  type Monitoring,
  monitoring,
  NOW,
  ORG,
  OTHER,
  PROJECT,
  personAuth,
} from "./test-support";

const MISSING = "44444444-4444-4444-8444-444444444444";
const VERSION = { version: 1 };
/** Every widget kind, as an agent writes them in full: what it reads back is the same. */
const DOCUMENT = {
  type: "ratel.dashboard",
  version: 1,
  name: "Everything",
  filters: { environments: ["production"] },
  range: "30d",
  widgets: [
    widget("Errors", "line", metric("error_rate", "rate", ["model"]), 0, 0),
    widget("", "number", metric("trace_count", "count"), 6, 0),
    widget(
      "",
      "bar",
      { ...metric("scorer_pass_rate", "rate"), filters: { scorer: { name: "Fast enough" } } },
      0,
      6,
    ),
    widget("", "table", metric("cost", "sum", ["model"]), 6, 6),
    widget(
      "",
      "flow",
      { ...VERSION, kind: "flow", node: "tool", steps: 5, edges: 50, filters: {} },
      0,
      12,
    ),
    widget(
      "",
      "funnel",
      {
        ...VERSION,
        kind: "funnel",
        order: "in_order",
        steps: [
          { name: "Called search", condition: { type: "tool", name: "search" } },
          {
            name: "Scored",
            condition: { type: "scorer", scorer: { name: "Fast enough" }, result: "passed" },
          },
        ],
        filters: {},
      },
      6,
      12,
    ),
    widget(
      "",
      "step_flow",
      {
        ...VERSION,
        kind: "step_flow",
        node: "skill",
        start: "intent",
        mode: "before",
        target: "triage",
        steps: 4,
        nodes: 5,
        filters: {},
      },
      0,
      24,
    ),
    widget("", "clusters", { ...VERSION, kind: "clusters", view: "asks" }, 0, 18),
    widget(
      "",
      "geography",
      {
        ...VERSION,
        kind: "geography",
        measures: [{ measure: "trace_count", aggregation: "count" }],
        level: "world",
        filters: {},
      },
      6,
      18,
    ),
  ],
};
const CALLS: readonly [string, object][] = [
  ["describe_monitoring_schema", {}],
  ["query_monitoring", { query: EXAMPLES.metric }],
  ["list_dashboards", {}],
  ["get_dashboard", { dashboardId: MISSING }],
  ["change_dashboard", { action: "create", name: "Board" }],
  ["import_dashboard", { document: DOCUMENT }],
  ["list_dashboard_templates", {}],
  ["import_dashboard", { template: "cost" }],
];

let m: Monitoring;
before(async () => {
  m = await monitoring((deps) => [
    ...dashboardReadOperations(deps),
    ...dashboardTemplateOperations(deps),
    ...dashboardWriteOperations(deps),
  ]);
});
beforeEach(async () => {
  await m.client.exec(
    "delete from dashboards; delete from trace_scorers; delete from otel_trace_summaries",
  );
  m.events.length = 0;
});
after(() => m.client.close());

test("each operation with and without access", async () => {
  for (const [id, params] of CALLS) {
    const expected = id === "get_dashboard" ? "not_found" : true;
    const keyed = await m.call(id, params);
    assert.equal(keyed.ok || keyed.error, expected, id);
    const member = await m.call(id, { ...params, projectId: PROJECT }, personAuth("member"));
    assert.equal(member.ok || member.error, expected, id);
    const other = await m.call(id, { ...params, projectId: OTHER });
    assert.equal(!other.ok && other.error, "forbidden", id);
    const stranger = await m.call(
      id,
      { ...params, projectId: PROJECT },
      personAuth("admin", MISSING),
    );
    assert.equal(!stranger.ok && stranger.error, "not_found", id);
  }
});

test("an agent reads the schema, imports a dashboard of every kind and reads it back equal", async () => {
  await createScorer(PROJECT, checkDraft(), "u", m.db);
  const { dashboard: schema } = await m.data<{ dashboard: object }>("describe_monitoring_schema", {
    part: "dashboard",
  });
  assert.match(JSON.stringify(schema), /must match every one/);
  assert.ok(z.fromJSONSchema(schema as never).safeParse(DOCUMENT).success);

  const { dashboardId, missingScorers } = await m.data<{
    dashboardId: string;
    missingScorers: string[];
  }>("import_dashboard", { document: DOCUMENT });
  assert.deepEqual(missingScorers, []);
  const read = await m.data<{ document: object; widgets: { kind: string; summary: string }[] }>(
    "get_dashboard",
    { dashboardId },
  );
  // A metric widget comes back as RQL with its form: the shape a widget is kept in.
  assert.deepEqual(read.document, asRql(DOCUMENT));
  assert.deepEqual([...new Set(read.widgets.map(({ kind }) => kind))].sort(), [
    "clusters",
    "flow",
    "funnel",
    "geography",
    "sql",
    "step_flow",
  ]);
  assert.ok(read.widgets.every(({ summary }) => summary.length > 0));
  const list = await m.data<{ dashboards: { name: string; updatedBy: string }[] }>(
    "list_dashboards",
  );
  assert.deepEqual(
    list.dashboards.map(({ name, updatedBy }) => [name, updatedBy]),
    [["Everything", "An agent (MCP)"]],
  );
});

test("an import through MCP equals the web app's", async () => {
  await createScorer(PROJECT, checkDraft(), "u", m.db);
  const { dashboardId } = await m.data<{ dashboardId: string }>("import_dashboard", {
    document: DOCUMENT,
  });
  const web = await changeDashboard(
    { projectId: PROJECT, action: "import", document: DOCUMENT },
    {
      getSession: async () => ({
        user: { id: "u", externalId: "u", name: "Ann", username: null, email: "a@b.c" },
      }),
      findProjectScope: async () => ({ project: { id: PROJECT }, organization: { id: ORG } }),
      isRestricted: async () => false,
      templates: { indexedProperties: async () => [], recordPick: async () => {} },
      scorers: async (projectId) => (await loadScorerPicker(projectId, new Date(), m.db)).scorers,
      store: {
        ...store,
        createDashboard: (input) => store.createDashboard(input, m.db),
      },
      observe: async () => {},
    },
  );
  assert.ok(web.ok);
  const content = async (id: string) => {
    const dashboard = await store.getDashboard(PROJECT, id, m.db);
    assert.ok(dashboard);
    const { name, filters, range, widgets } = dashboard;
    return { name, filters, range, widgets: widgets.map((item) => ({ ...item, id: "" })) };
  };
  assert.deepEqual(await content(dashboardId), await content(web.dashboardId));
});

test("a missing scorer is named, and its widget says what is wrong", async () => {
  const result = await m.call("import_dashboard", { document: DOCUMENT });
  assert.ok(result.ok);
  assert.deepEqual((result.data as { missingScorers: string[] }).missingScorers, ["Fast enough"]);
  assert.match(result.hint ?? "", /Fast enough/);
  const { widgets } = result.data as { widgets: { problem?: string }[] };
  assert.equal(widgets.filter(({ problem }) => problem).length, 2);
});

test("a dashboard is created, changed widget by widget and deleted", async () => {
  const { dashboardId } = await m.data<{ dashboardId: string }>("change_dashboard", {
    action: "create",
    name: "Board",
  });
  const change = (action: string, rest: object = {}) =>
    m.data<{ widgets: { id: string; name: string; layout: object }[] }>("change_dashboard", {
      action,
      dashboardId,
      ...rest,
    });
  await change("rename", { name: "Speed" });
  await change("set_filters", { filters: { models: ["a"] } });
  await change("set_filters", { range: "7d" });
  let stored = await store.getDashboard(PROJECT, dashboardId, m.db);
  assert.deepEqual(
    [stored?.name, stored?.filters, stored?.range],
    ["Speed", { models: ["a"] }, "7d"],
  );

  await change("add_widget", { widget: { query: EXAMPLES.metric, chart: "line" } });
  const added = await change("add_widget", { widget: { query: EXAMPLES.flow, chart: "flow" } });
  const [line, flow] = added.widgets;
  const changed = await change("change_widget", { widgetId: line.id, widget: { title: "Errors" } });
  assert.equal(changed.widgets[0].name, "Errors");
  const moved = await change("move_widgets", {
    layouts: {
      [flow.id]: { x: 0, y: 0, w: 12, h: 4 },
      [line.id]: { x: 0, y: 4, w: 12, h: 4 },
    },
  });
  assert.deepEqual(
    moved.widgets.map(({ id }) => id),
    [flow.id, line.id],
  );
  const left = await change("remove_widget", { widgetId: flow.id });
  assert.deepEqual(
    left.widgets.map(({ name, layout }) => [name, layout]),
    [["Errors", { x: 0, y: 0, w: 12, h: 4 }]],
  );
  await change("delete");
  stored = await store.getDashboard(PROJECT, dashboardId, m.db);
  assert.equal(stored, null);
  const starter = await m.data<{ widgets: object[] }>("change_dashboard", {
    action: "create_starter",
  });
  assert.equal(starter.widgets.length, 4);
  assert.ok(m.events.every(({ fields }) => fields.surface === "mcp"));
});

test("each refusal is an MCP error", async () => {
  const { dashboardId } = await m.data<{ dashboardId: string }>("change_dashboard", {
    action: "create",
    name: "Board",
  });
  const at = { dashboardId };
  const refusals: [string, object, string, RegExp][] = [
    ["change_dashboard", { action: "create" }, "invalid_params", /Pass name/],
    ["change_dashboard", { action: "create", name: " " }, "invalid_params", /a name/],
    ["change_dashboard", { action: "delete" }, "invalid_params", /Pass dashboardId/],
    ["change_dashboard", { action: "delete", dashboardId: MISSING }, "not_found", /no longer/],
    ["change_dashboard", { action: "set_filters", ...at }, "invalid_params", /filters or range/],
    ["change_dashboard", { action: "remove_widget", ...at, widgetId: "x" }, "not_found", /widget/],
    [
      "change_dashboard",
      { action: "change_widget", ...at, widgetId: "x", widget: {} },
      "not_found",
      /widget/,
    ],
    [
      "change_dashboard",
      { action: "add_widget", ...at, widget: { query: EXAMPLES.flow, chart: "line" } },
      "invalid_params",
      /A flow is drawn as a flow/,
    ],
    [
      "import_dashboard",
      { document: { ...DOCUMENT, version: 2 } },
      "invalid_params",
      /Unknown dashboard version/,
    ],
    [
      "import_dashboard",
      { document: { ...DOCUMENT, widgets: [{ ...DOCUMENT.widgets[0], chart: "pie" }] } },
      "invalid_params",
      /^Widget 1 "Errors"/,
    ],
    ["get_dashboard", { dashboardId: MISSING }, "not_found", /dashboard/],
  ];
  for (const [id, params, error, message] of refusals) {
    const result = await m.call(id, params);
    assert.equal(!result.ok && result.error, error, `${id} ${JSON.stringify(params)}`);
    assert.match(result.ok ? "" : result.message, message);
  }
  for (let n = 1; n < 100; n++)
    await store.createDashboard(
      { projectId: PROJECT, name: `d${n}`, widgets: [], updatedBy: "u", updatedByName: null },
      m.db,
    );
  const full = await m.call("change_dashboard", { action: "create", name: "One more" });
  assert.equal(!full.ok && full.error, "conflict");
});

test("one byte over the filter budget is refused with the same message by each operation", async () => {
  const message = "The filters are too long: 3,073 bytes of JSON, 3,072 at most.";
  const page = { agents: ["p".repeat(400)] };
  const query = (bytes: number, filters: object | null) => {
    const own = (text: string) => ({ tools: ["t".repeat(1_900), text] });
    const merged = (text: string) =>
      JSON.stringify(filters ? { ...own(text), and: [filters] } : own(text)).length;
    return { ...metric("latency", "p95"), filters: own("x".repeat(bytes - merged(""))) };
  };
  const { dashboardId } = await m.data<{ dashboardId: string }>("change_dashboard", {
    action: "create",
    name: "Budget",
  });
  await m.data("change_dashboard", { action: "set_filters", dashboardId, filters: page });
  const add = (bytes: number) => ({
    action: "add_widget",
    dashboardId,
    widget: { query: query(bytes, page), chart: "line" },
  });
  const document = (bytes: number) => ({
    document: {
      ...DOCUMENT,
      filters: page,
      widgets: [widget("Long", "line", query(bytes, page), 0, 0)],
    },
  });
  const ask = (bytes: number) => ({ query: query(bytes, page), filters: page });
  const calls: [string, (bytes: number) => object][] = [
    ["change_dashboard", add],
    ["import_dashboard", document],
    ["query_monitoring", ask],
    ["query_monitoring", (bytes) => ({ query: query(bytes, null) })],
  ];
  for (const [id, params] of calls) {
    const at = await m.call(id, params(3_072));
    assert.ok(at.ok, `${id} ${at.ok ? "" : at.message}`);
    const over = await m.call(id, params(3_073));
    assert.equal(!over.ok && over.error, "invalid_params", id);
    assert.ok(!over.ok && over.message.includes(message), over.ok ? id : over.message);
  }
  const { catalog } = await m.data<{ catalog: object }>("describe_monitoring_schema");
  assert.match(JSON.stringify(catalog), /3,072 bytes of JSON at most/);
});

test("F445-6: a clusters query over the budget is refused by each operation", async () => {
  const query = (bytes: number) => {
    const lists = (text: string) => ({ tools: ["t".repeat(1_900), text], tasks: ["task"] });
    const rest = bytes - JSON.stringify(lists("")).length;
    return { version: 1, kind: "clusters", view: "asks", ...lists("x".repeat(rest)) };
  };
  const { dashboardId } = await m.data<{ dashboardId: string }>("change_dashboard", {
    action: "create",
    name: "Map",
  });
  const calls: [string, (bytes: number) => object][] = [
    [
      "change_dashboard",
      (bytes) => ({
        action: "add_widget",
        dashboardId,
        widget: { query: query(bytes), chart: "clusters" },
      }),
    ],
    [
      "import_dashboard",
      (bytes) => ({
        document: { ...DOCUMENT, widgets: [widget("Map", "clusters", query(bytes), 0, 0)] },
      }),
    ],
    ["query_monitoring", (bytes) => ({ query: query(bytes) })],
  ];
  for (const [id, params] of calls) {
    const over = await m.call(id, params(3_073));
    assert.equal(!over.ok && over.error, "invalid_params", id);
    assert.ok(!over.ok && over.message.includes("3,073 bytes of JSON, 3,072 at most"), id);
  }
});

test("F445-7: hostile JSON and a NUL character are invalid parameters", async () => {
  const nul = "a\u0000b";
  for (const document of [
    { ...DOCUMENT, type: { toString: 1 } },
    { ...DOCUMENT, name: nul },
  ]) {
    const result = await m.call("import_dashboard", { document });
    assert.equal(!result.ok && result.error, "invalid_params");
  }
  const asked = await m.call("query_monitoring", {
    query: { ...metric("latency", "p95"), filters: { models: [nul] } },
  });
  assert.equal(!asked.ok && asked.error, "invalid_params");
});

test("a step flow: its steps in the text form, its schema, and the path of what is wrong", async () => {
  await insertTrace(m.client, "a", 100, true);
  const { result, summary } = await m.data<{
    result: { columns: { nodes: { kind: string; share: number }[] }[] };
    summary: string;
  }>("query_monitoring", { query: EXAMPLES.step_flow });
  assert.equal(summary, "1 traces, the most at each step: no step");
  assert.deepEqual(
    result.columns.map(({ nodes }) => nodes.map(({ kind, share }) => [kind, share])),
    [[["start", 1]], [["ended", 1]], []],
  );
  assert.deepEqual(Object.keys(result).sort(), [
    "columns",
    "kind",
    "links",
    "marks",
    "sample",
    "total",
  ]);

  const { catalog, query } = await m.data<{ catalog: object; query: object }>(
    "describe_monitoring_schema",
  );
  assert.match(JSON.stringify(catalog), /"step_flow"/);
  const published = z.fromJSONSchema(query as never);
  assert.ok(!published.safeParse({ ...EXAMPLES.step_flow, steps: 7 }).success);

  for (const [change, path] of [
    [{ node: "scorer" }, "query.node"],
    [{ steps: 7 }, "query.steps"],
    [{ mode: "before" }, "query.target"],
  ] as const) {
    const refused = await m.call("query_monitoring", {
      query: { ...EXAMPLES.step_flow, ...change },
    });
    assert.ok(!refused.ok);
    assert.equal(refused.error, "invalid_params");
    assert.match(refused.message, new RegExp(`invalid at "${path}"`));
  }
});

test("query_monitoring refuses a panel of kind sql: it is asked alone, or kept as a widget", async () => {
  const refused = await m.call("query_monitoring", {
    queries: [
      { query: EXAMPLES.metric },
      { query: { version: 1, kind: "sql", text: "select count(*) from traces", rqlVersion: 1 } },
    ],
  });
  assert.ok(!refused.ok);
  assert.equal(refused.error, "invalid_params");
  assert.match(refused.message, /kind sql cannot be a panel/);
});

test("a sql widget: change_dashboard, get_dashboard and import_dashboard carry it", async () => {
  await insertTrace(m.client, "a", 100, true);
  await insertTrace(m.client, "b", 300);
  const sql = {
    version: 1,
    kind: "sql",
    text: "select count(*) as traces from traces",
    rqlVersion: 1,
  };
  const { dashboardId } = await m.data<{ dashboardId: string }>("change_dashboard", {
    action: "create",
    name: "RQL",
  });
  const add = { action: "add_widget", dashboardId, widget: { query: sql, chart: "sql" } };
  await m.data("change_dashboard", add);
  const broken = { query: { ...sql, text: "select * from spans" }, chart: "sql" };
  await m.data("change_dashboard", { ...add, widget: broken });
  await m.data("change_dashboard", {
    action: "set_filters",
    dashboardId,
    filters: { environments: ["production"] },
  });
  const read = await m.data<{
    widgets: { summary: string }[];
    document: { widgets: { query: object; chart: string }[] };
  }>("get_dashboard", { dashboardId });
  // The dashboard's filter narrows it as it runs (`synthesis/rql/domain/page-filter.ts`).
  assert.equal(read.widgets[0].summary, "1 row of 1 column: traces.");
  assert.match(read.widgets[1].summary, /RQL refused the query: .*spans/);
  assert.deepEqual(read.document.widgets[0], { ...read.document.widgets[0], query: sql });
  // An old chart "sql" is kept as the chart its rows draw: one number with no time is a table.
  assert.equal(read.document.widgets[0].chart, "table");

  const imported = await m.data<{ dashboardId: string }>("import_dashboard", {
    document: read.document,
  });
  const copy = await store.getDashboard(PROJECT, imported.dashboardId, m.db);
  assert.deepEqual(
    copy?.widgets.map((widget) => "query" in widget && widget.query),
    [sql, broken.query],
  );
  const { catalog } = await m.data<{ catalog: { kinds: { kind: string; charts: string[] }[] } }>(
    "describe_monitoring_schema",
    { part: "catalog" },
  );
  assert.deepEqual(catalog.kinds.find(({ kind }) => kind === "sql")?.charts, [
    "line",
    "bar",
    "number",
    "table",
  ]);
});

test("a sql widget on a 3 month range: get_dashboard reads the whole range, and as sql gives the text", async () => {
  const sql = {
    version: 1,
    kind: "sql",
    text: "select count(*) as traces from traces",
    rqlVersion: 1,
  };
  const { dashboardId } = await m.data<{ dashboardId: string }>("change_dashboard", {
    action: "create",
    name: "Long range",
  });
  await m.data("change_dashboard", {
    action: "add_widget",
    dashboardId,
    widget: { query: sql, chart: "sql" },
  });
  const read = await m.data<{ widgets: { summary: string; result?: { rows: unknown[][] } }[] }>(
    "get_dashboard",
    { dashboardId, since: new Date(NOW.getTime() - 90 * 86_400_000).toISOString() },
  );
  assert.doesNotMatch(read.widgets[0].summary, /last 30 days/);
  // A metric over a long range has its RQL text, as the console makes it.
  const long = await m.data<{ text: string }>("query_monitoring", {
    query: {
      version: 1,
      kind: "metric",
      measures: [{ measure: "trace_count", aggregation: "count" }],
    },
    chart: "number",
    as: "sql",
    since: new Date(NOW.getTime() - 60 * 86_400_000).toISOString(),
  });
  assert.match(long.text, /select count\(\*\) as value\nfrom traces/);
});

test("query_monitoring as sql gives the RQL text of a metric (Edit as SQL)", async () => {
  await insertTrace(m.client, "a", 100, true);
  await insertTrace(m.client, "b", 300);
  const params = {
    query: {
      version: 1,
      kind: "metric",
      measures: [{ measure: "trace_count", aggregation: "count" }],
    },
    chart: "number",
    as: "sql",
  };
  const { text, query } = await m.data<{ text: string; query: { kind: string; text: string } }>(
    "query_monitoring",
    params,
  );
  assert.equal(text, "select count(*) as value\nfrom traces");
  assert.deepEqual([query.kind, query.text], ["sql", text]);
  // The text gives the numbers of the form.
  const form = await m.data<{ result: { series: { total: number }[] } }>("query_monitoring", {
    query: params.query,
    chart: "number",
  });
  const rows = await m.data<{ result: { rows: unknown[][] } }>("query_monitoring", { query });
  assert.deepEqual(rows.result.rows, [[form.result.series[0].total]]);
  // A rate has its RQL text too, and gives the form's number.
  const rateQuery = {
    version: 1,
    kind: "metric",
    measures: [{ measure: "error_rate", aggregation: "rate" }],
  };
  const rate = await m.data<{ query: unknown; text: string }>("query_monitoring", {
    ...params,
    query: rateQuery,
  });
  assert.match(rate.text, /rate\(coalesce\(root_error, has_error\)\)/);
  const rateForm = await m.data<{ result: { series: { total: number }[] } }>("query_monitoring", {
    query: rateQuery,
    chart: "number",
  });
  const rateRows = await m.data<{ result: { rows: unknown[][] } }>("query_monitoring", {
    query: rate.query,
  });
  assert.deepEqual(rateRows.result.rows, [[rateForm.result.series[0].total]]);
});

test("query_monitoring runs each kind", async () => {
  await insertTrace(m.client, "a", 100, true);
  await insertTrace(m.client, "b", 300);
  for (const [kind, query] of Object.entries(EXAMPLES)) {
    const { result, summary } = await m.data<{ result: { kind: string }; summary: string }>(
      "query_monitoring",
      { query },
    );
    assert.equal(result.kind, kind);
    assert.ok(summary.length > 0, kind);
  }
  const { query: schema } = await m.data<{ query: object }>("describe_monitoring_schema", {
    part: "query",
  });
  const published = z.fromJSONSchema(schema as never);
  for (const query of Object.values(EXAMPLES)) assert.ok(published.safeParse(query).success);
  assert.ok(!published.safeParse({ version: 1, kind: "pie" }).success);

  const latency = await m.call("query_monitoring", {
    query: metric("latency", "p50"),
    since: "2026-11-24T00:00:00Z",
    until: "2026-11-25T00:00:00Z",
  });
  assert.ok(latency.ok);
  assert.deepEqual(latency.window, {
    since: "2026-11-24T00:00:00.000Z",
    until: "2026-11-25T00:00:00.000Z",
  });
  const { summary, result } = latency.data as { summary: string; result: { series: object[] } };
  assert.equal(summary, "200 ms");
  assert.equal((result.series[0] as { total: number }).total, 200);
});

test("a result has the Explore link of the same queries, filters and range", async () => {
  await insertTrace(m.client, "a", 100);
  const opened = (href: string) => {
    const params = new URL(href, "https://x.test").searchParams;
    const decoded = decodePanels(params.get(PANELS_PARAM));
    assert.ok(decoded.ok);
    return {
      panels: decoded.panels,
      filters: shownFilters(`?${params}`, {}),
      range: [params.get("range"), params.get("from"), params.get("to")],
    };
  };
  const filters = { environments: ["production"], agents: ["a"] };
  const days = { since: "2026-11-20T00:00:00Z", until: "2026-11-24T00:00:00Z" };
  for (const [kind, query] of Object.entries(EXAMPLES)) {
    const { href } = await m.data<{ href: string }>("query_monitoring", {
      query,
      filters,
      ...days,
    });
    const parsed = querySchema.parse(query);
    assert.deepEqual(opened(href), {
      // A metric opens in Explore as RQL with its form, as a widget keeps it.
      panels: [
        parsed.kind === "metric"
          ? formWidget(formOf(parsed), "line")
          : { title: "", query: parsed, chart: kind },
      ],
      filters,
      range: ["exact", "2026-11-20T00:00:00.000Z", "2026-11-24T00:00:00.000Z"],
    });
  }

  const { widgets, href, name, summary } = await m.data<{
    widgets: { id: string; name: string; summary: string; result: { kind: string } }[];
    href: string;
    name: string;
    summary: string;
  }>("query_monitoring", {
    queries: [
      { title: "Speed", query: metric("latency", "p50"), chart: "number" },
      { query: EXAMPLES.step_flow },
    ],
    ...days,
    until: "2026-11-25T00:00:00Z",
  });
  assert.equal(name, "Explore");
  assert.deepEqual(
    widgets.map(({ id, name, result }) => [id, name, result.kind]),
    [
      ["panel-1", "Speed", "metric"],
      ["panel-2", "Tool step flow by intent", "step_flow"],
    ],
  );
  assert.match(summary, /^Speed: 100 ms\nTool step flow by intent: 1 traces/);
  assert.deepEqual(
    opened(href).panels.map(({ title, chart }) => [title, chart]),
    [
      ["Speed", "number"],
      ["", "step_flow"],
    ],
  );
});

test("the clauses of a query all match, and its Explore link has them", async () => {
  await insertTrace(m.client, "c", 100);
  await m.client.exec("update otel_trace_summaries set environment = 'production'");
  const run = (filters: object) =>
    m.data<{ href: string; summary: string }>("query_monitoring", {
      query: { ...metric("trace_count", "count"), filters },
      range: "7d",
    });
  const production = { environments: ["production"] };
  assert.match((await run(production)).summary, /[1-9]/);
  const filters = { ...production, and: [{ environments: ["staging"] }] };
  const { href, summary } = await run(filters);
  assert.equal(summary, "no data in this window");
  const decoded = decodePanels(new URL(href, "https://x.test").searchParams.get(PANELS_PARAM));
  assert.ok(decoded.ok);
  const { query } = decoded.panels[0];
  assert.deepEqual(query.kind === "sql" && query.form?.filters, filters);
});

test("the Explore link reads exactly the window of the MCP result", async () => {
  const at = (id: string, time: string) =>
    insertTrace(m.client, id).then(() =>
      m.client.query("update otel_trace_summaries set started_at = $1 where trace_id = $2", [
        time,
        id,
      ]),
    );
  await at("before", "2026-11-23T11:59:59.999Z");
  await at("first", "2026-11-23T12:00:00.000Z");
  await at("last", "2026-11-23T12:59:59.999Z");
  await at("after", "2026-11-23T13:00:00.000Z");
  await insertTrace(m.client, "now");
  const registry = buildRegistry(dashboardReadOperations(m.deps));
  for (const [window, count] of [
    [{ since: "2026-11-23T12:00:00Z", until: "2026-11-23T13:00:00Z" }, 2],
    // The default ends now.
    [{}, 5],
  ] as const) {
    const mcp = await dispatchOperation(
      "query_monitoring",
      { query: metric("trace_count", "count"), ...window },
      { registry, auth: KEY_AUTH, forView: true },
    );
    assert.ok(mcp.ok);
    const [{ result }] = (mcp.view as { widgets: { result: MetricResult }[] }).widgets;
    assert.equal(result.series[0].total, count);
    const { href } = mcp.data as { href: string };
    const { searchParams } = new URL(href, "https://x.test");
    const decoded = decodePanels(searchParams.get(PANELS_PARAM));
    assert.ok(decoded.ok);
    // What the Explore page runs, a day later.
    const later = new Date(NOW.getTime() + 86_400_000);
    const { since, until } = resolveWidgetRange(Object.fromEntries(searchParams), later);
    assert.deepEqual(mcp.window, { since: since.toISOString(), until: until.toISOString() });
    // The panel is RQL with its form: the form's metric gives the numbers the view drew.
    const panel = decoded.panels[0].query;
    const web = await m.deps.runQuery(
      PROJECT,
      panel.kind === "sql" && panel.form ? metricOfForm(panel.form) : panel,
      {
        since,
        until,
        filter: {},
      },
    );
    assert.deepEqual(web, result);
  }
});

test("query_monitoring takes one query, or two to four panels", async () => {
  const query = EXAMPLES.metric;
  const bad = { query: { ...EXAMPLES.flow, steps: 99 } };
  for (const [params, says] of [
    [{}, /query, or queries/],
    [{ query, queries: [{ query }, { query }] }, /query, or queries/],
    [{ queries: [{ query }, bad] }, /invalid at "queries\.1\.query\.steps"/],
    [{ queries: [{ query }, { query, chart: "flow" }] }, /cannot be drawn as a flow/],
    [{ queries: [{ query }, { query }], chart: "bar" }, /its own chart/],
    [{ queries: [{ query }] }, /./],
    [{ queries: Array(5).fill({ query }) }, /./],
  ] as const) {
    const refused = await m.call("query_monitoring", params);
    assert.ok(!refused.ok, JSON.stringify(params));
    assert.equal(refused.error, "invalid_params");
    assert.match(refused.message, says);
  }
});

test("a wide result is cut to its newest points and says so", async () => {
  const wide = await m.call("query_monitoring", {
    query: { ...metric("trace_count", "count"), bucket: "day" },
    since: "2025-11-24T00:00:00Z",
  });
  assert.ok(wide.ok && wide.truncated);
  const { result } = wide.data as { result: { buckets: string[]; series: { values: object[] }[] } };
  assert.equal(result.buckets.length, POINT_CAP);
  assert.equal(result.series[0].values.length, POINT_CAP);
  assert.equal(result.buckets.at(-1)?.slice(0, 10), "2026-11-24");
});

test("an invalid query is refused with the path of each error", async () => {
  const refused: [object, string][] = [
    [{ ...VERSION, kind: "pie" }, "query.kind"],
    [metric("latency", "sum"), "query.measures.0.aggregation"],
    [{ ...metric("latency", "p50"), filters: { tool: ["x"] } }, "query.filters"],
    [metric("context_cost", "sum", ["model"]), "query.dimensions.0"],
    [{ ...EXAMPLES.funnel, steps: [EXAMPLES.funnel.steps[0]] }, "query.steps"],
  ];
  for (const [query, path] of refused) {
    const result = await m.call("query_monitoring", { query });
    assert.equal(!result.ok && result.error, "invalid_params", path);
    assert.ok(
      !result.ok && result.issues?.some((issue) => issue.path === path),
      JSON.stringify(result),
    );
    assert.ok(!result.ok && result.message.includes(`"${result.issues?.[0].path}"`));
  }
  const filters = await m.call("query_monitoring", {
    query: EXAMPLES.metric,
    filters: { environments: "x" },
  });
  assert.ok(!filters.ok && filters.issues?.[0].path === "filters.environments");
  const chart = await m.call("query_monitoring", {
    query: metric("cost", "sum", ["model"]),
    chart: "number",
  });
  assert.ok(!chart.ok && chart.issues?.[0].path === "chart");
});

function metric(measure: string, aggregation: string, dimensions: string[] = []) {
  return {
    ...VERSION,
    kind: "metric",
    measures: [{ measure, aggregation }],
    dimensions,
    filters: {},
  };
}

/** A document with each metric widget as RQL with its form, as get_dashboard exports it. */
function asRql(document: typeof DOCUMENT) {
  return {
    ...document,
    widgets: document.widgets.map((item) => {
      const query = item.query as MetricQuery;
      if (query.kind !== "metric") return item;
      const form = formOf(query);
      const scorer = (query.filters as { scorer?: { name: string } }).scorer;
      const text = metricAsRql(form, item.chart as MetricChartKind, "hour", {
        ...(scorer ? { scorerName: scorer.name } : {}),
      });
      return { ...item, query: { ...VERSION, kind: "sql", text, rqlVersion: 1, form } };
    }),
  };
}

function widget(title: string, chart: string, query: object, x: number, y: number) {
  return { title, query, chart, layout: { x, y, w: 6, h: 6 } };
}

test("list_dashboards gives the defaults one time; a template makes a dashboard", async () => {
  await m.client.exec("delete from dashboard_template_uses; delete from trace_property_keys");

  const listed = await m.call("list_dashboards", {});
  assert.ok(listed.ok);
  const names = (result: Awaited<ReturnType<typeof m.call>>) =>
    result.ok
      ? (result.data as { dashboards: { name: string }[] }).dashboards.map(({ name }) => name)
      : [];
  assert.deepEqual(names(listed), ["Tools", "Cost", "Reliability"]);
  assert.deepEqual(names(await m.call("list_dashboards", {})), ["Tools", "Cost", "Reliability"]);

  const templates = await m.call("list_dashboard_templates", {});
  assert.ok(templates.ok);
  const listedTemplates = (
    templates.data as {
      templates: { id: string; description: string; hasData: boolean; missing: string[] }[];
    }
  ).templates;
  assert.equal(listedTemplates.length, 10);
  assert.deepEqual(
    listedTemplates.find(({ id }) => id === "quality"),
    {
      id: "quality",
      name: "Quality",
      description: listedTemplates.find(({ id }) => id === "quality")?.description,
      needs: ["scores"],
      hasData: false,
      missing: ["No scorer yet"],
    },
  );

  const made = await m.call("import_dashboard", { template: "agents" });
  assert.ok(made.ok);
  assert.equal((made.data as { dashboard: { name: string } }).dashboard.name, "Agents");
  const both = await m.call("import_dashboard", { template: "agents", document: DOCUMENT });
  assert.equal(!both.ok && both.error, "invalid_params");
  const property = await m.call("import_dashboard", { template: "by-customer", property: "plan" });
  assert.equal(!property.ok && property.error, "invalid_params");
  assert.match(!property.ok ? property.message : "", /The property plan is not indexed/);
});
