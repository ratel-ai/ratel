import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { type MeasureId, type MetricQuery, metricQuery } from "@/lib/contracts/query";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { type MetricsDb, metricSeams, runQuery } from "@/lib/synthesis/metrics/query";
import { createPgRqlExecutor } from "@/lib/synthesis/rql/adapters/pg-executor";
import { sqlQueryRunner } from "@/lib/synthesis/rql/query";
import { createRqlGate } from "@/lib/synthesis/rql/run";
import { pglitePoolOf } from "@/lib/synthesis/rql/tests/test-support";
import { changeDashboard, type DashboardActionDeps } from "@/lib/views/dashboards/actions";
import { loadWidget, loadWidgets } from "@/lib/views/dashboards/data";
import { dashboardDocumentSchema, exportDashboard } from "@/lib/views/dashboards/document";
import { barChange, filtersProblem } from "@/lib/views/dashboards/filters";
import { gridPositionSchema, inReadingOrder } from "@/lib/views/dashboards/layout";
import { parseWidget } from "@/lib/views/dashboards/parse-widget";
import { STARTER_WIDGETS } from "@/lib/views/dashboards/starter";
import {
  changeWidgets,
  countDashboards,
  createDashboard,
  type DashboardsDb,
  deleteDashboard,
  getDashboard,
  listDashboards,
  updateDashboard,
} from "@/lib/views/dashboards/store";
import { isBroken, isWidget } from "@/lib/views/dashboards/stored-widget";
import {
  type DashboardFilters,
  MAX_WIDGETS,
  type WidgetInput,
  type WidgetQuery,
  type WidgetResult,
} from "@/lib/views/dashboards/types";
import {
  changeQuery,
  fitWidget,
  queryScorerId,
  scorersOfMetric,
  scorerWidget,
  sqlWidgetQuery,
  widgetName,
} from "@/lib/views/dashboards/widget";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const WIDGET = {
  title: "",
  query: metricQuery("latency", "p95", { filters: { models: ["gpt-4o"] } }),
  chart: "line",
} as const;
const query = (change: object) => ({ query: { ...WIDGET.query, ...change } });

let client: Awaited<ReturnType<typeof createMigratedPGlite>>;
let db: DashboardsDb;

before(async () => {
  client = await createMigratedPGlite();
  db = drizzle(client, { schema }) as unknown as DashboardsDb;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'), ('${OTHER}', '${ORG}', 'Other', 'other');
  `);
});
beforeEach(() => client.exec("delete from dashboards"));
after(() => client.close());

test("create, rename and delete a dashboard", async () => {
  const id = await created("  Latency  ");
  assert.equal((await getDashboard(PROJECT, id, db))?.name, "Latency");
  await ok({ action: "rename", dashboardId: id, name: "Speed" });
  assert.deepEqual(
    (await listDashboards(PROJECT, db)).map((d) => [d.id, d.name, d.widgetCount]),
    [[id, "Speed", 0]],
  );
  await ok({ action: "delete", dashboardId: id });
  assert.deepEqual(await listDashboards(PROJECT, db), []);
  await refused({ action: "delete", dashboardId: id }, /no longer exists/);
});

test("add, edit, move and remove a widget", async () => {
  const id = await created();
  for (const title of ["a", "b", "c"])
    await ok({ action: "add-widget", dashboardId: id, widget: { ...WIDGET, title } });
  const [a, b, c] = inReadingOrder(await widgets(id));
  assert.deepEqual(a, {
    ...WIDGET,
    title: "a",
    id: a.id,
    layout: { x: 0, y: 0, w: 6, h: 6 },
  });

  await ok({
    action: "edit-widget",
    dashboardId: id,
    widgetId: b.id,
    widget: { ...WIDGET, title: "B" },
  });
  assert.deepEqual(await widget(id, b.id), { ...b, title: "B" });

  const layouts = {
    [c.id]: { x: 0, y: 0, w: 12, h: 4 },
    [a.id]: { x: 6, y: 4, w: 6, h: 6 },
    [b.id]: { x: 0, y: 4, w: 6, h: 6 },
  };
  await ok({ action: "save-layout", dashboardId: id, layouts });
  assert.deepEqual(await titles(id), ["c", "B", "a"]);
  assert.deepEqual((await widget(id, a.id))?.layout, layouts[a.id]);

  await ok({ action: "remove-widget", dashboardId: id, widgetId: c.id });
  assert.deepEqual(await titles(id), ["B", "a"]);
  assert.equal((await widget(id, a.id))?.layout.y, 0, "the rest moves up");
  // The undo of a removal puts it back where it was.
  await ok({
    action: "add-widget",
    dashboardId: id,
    layout: layouts[c.id],
    widget: { ...WIDGET, title: "c" },
  });
  assert.deepEqual(await titles(id), ["c", "B", "a"]);
  await ok({ action: "remove-widget", dashboardId: id, widgetId: b.id });
  await refused(
    { action: "remove-widget", dashboardId: id, widgetId: b.id },
    /widget no longer exists/,
  );
});

test("two people at once: a saved layout loses no widget and brings none back", async () => {
  const id = await created();
  for (const title of ["a", "b"])
    await ok({ action: "add-widget", dashboardId: id, widget: { ...WIDGET, title } });
  const seen = inReadingOrder(await widgets(id));
  // Meanwhile another person adds one and removes one.
  await ok({ action: "add-widget", dashboardId: id, widget: { ...WIDGET, title: "new" } });
  await ok({ action: "remove-widget", dashboardId: id, widgetId: seen[1].id });
  const layouts = {
    [seen[0].id]: { x: 0, y: 0, w: 12, h: 8 },
    [seen[1].id]: { x: 0, y: 8, w: 12, h: 8 },
  };
  await ok({ action: "save-layout", dashboardId: id, layouts });
  assert.deepEqual(await titles(id), ["a", "new"]);
  const [, added] = inReadingOrder(await widgets(id));
  assert.ok(added.layout.y >= 8, "it made room");
});

test("a widget change reads its row for update, inside the transaction that writes it", async () => {
  const id = await created();
  const statements: string[] = [];
  const logged = drizzle(client, {
    schema,
    logger: { logQuery: (query) => statements.push(query) },
  }) as unknown as DashboardsDb;
  await changeWidgets(
    { projectId: PROJECT, id, change: (all) => all, updatedBy: "u", updatedByName: null },
    logged,
  );
  assert.equal(statements.length, 2);
  assert.match(statements[0], /^select .* for update$/);
  assert.match(statements[1], /^update "dashboards"/);
});

test("one byte over the filter budget, with the dashboard's filters, is refused by every change", async () => {
  const id = await created();
  const message = "The filters are too long: 3,073 bytes of JSON, 3,072 at most.";
  const page = { agents: ["p".repeat(400)] };
  // What the widget's filter and the dashboard's are as one.
  const sized = (bytes: number) => {
    const filters = (text: string) => ({ tools: ["t".repeat(1_900), text] });
    const merged = (text: string) => JSON.stringify({ ...filters(text), and: [page] }).length;
    return filters("x".repeat(bytes - merged("")));
  };
  const widget = (bytes: number) => ({
    ...WIDGET,
    query: { ...WIDGET.query, filters: sized(bytes) },
  });
  const refused = async (input: object) => {
    const result = await run(input);
    return result.ok ? null : result.error;
  };
  const defaults = { filters: page, range: null };
  await ok({ action: "save-defaults", dashboardId: id, defaults });
  await ok({ action: "add-widget", dashboardId: id, widget: widget(3_072) });
  const [{ id: widgetId }] = await widgets(id);
  const over = widget(3_073);
  assert.equal(await refused({ action: "add-widget", dashboardId: id, widget: over }), message);
  assert.equal(
    await refused({ action: "edit-widget", dashboardId: id, widgetId, widget: over }),
    message,
  );
  const longer = { filters: { agents: [`${page.agents[0]}p`] }, range: null };
  assert.equal(
    await refused({ action: "save-defaults", dashboardId: id, defaults: longer }),
    message,
  );
  const alone = { filters: { agents: ["p".repeat(1_900), "q".repeat(1_155)] }, range: null };
  assert.match(
    (await refused({ action: "save-defaults", dashboardId: id, defaults: alone })) ?? "",
    /^The filters are too long: 3,07\d bytes of JSON, 3,072 at most\.$/,
  );
  const document = (bytes: number) => ({
    type: "ratel.dashboard",
    version: 1,
    name: "Long",
    filters: page,
    range: null,
    widgets: [{ ...widget(bytes), layout: { x: 0, y: 0, w: 6, h: 6 } }],
  });
  assert.equal(await refused({ action: "import", document: document(3_072) }), null);
  const named = await refused({ action: "import", document: document(3_073) });
  assert.ok(named?.startsWith("Widget 1") && named.endsWith(`: ${message}`), String(named));
  // The widget editor and the filter bar ask the same before they send a change.
  const queryOf = (bytes: number) => widget(bytes).query as WidgetQuery;
  assert.equal(filtersProblem([queryOf(3_072)], page), null);
  assert.equal(filtersProblem([queryOf(3_073)], page), message);
  const bar = (agent: string) =>
    barChange(`?facetAgent=${agent}`, { search: "", saved: {}, queries: [queryOf(3_072)] }).refused;
  assert.equal(bar("p".repeat(400)), null);
  assert.equal(bar("p".repeat(401)), message);
});

test("a stored widget that is not one is a broken entry; the rest loads, and the entry is kept until it is removed", async () => {
  const id = await created();
  await ok({ action: "add-widget", dashboardId: id, widget: { ...WIDGET, title: "fine" } });
  const [fine] = await widgets(id);
  const place = { x: 6, y: 0, w: 6, h: 6 };
  const bad = [
    // The round-one shape.
    { id: "r1", title: "Old", metric: "latency", aggregation: "p95", groupBy: null, filter: {} },
    { ...fine, id: "kind", title: "Flow", query: { ...WIDGET.query, kind: "pie" }, layout: place },
    { ...fine, id: "gone", title: "", query: undefined, layout: { x: 9, y: 0, w: 9, h: 1 } },
    { ...fine, title: "Twice" },
    null,
  ];
  await client.query("update dashboards set widgets = $1 where id = $2", [
    JSON.stringify([bad[0], fine, ...bad.slice(1)]),
    id,
  ]);
  const read = (await getDashboard(PROJECT, id, db))?.widgets ?? [];
  assert.deepEqual(
    read.map((item) => (isBroken(item) ? [item.title, item.problem] : item.title)),
    [
      ["Old", "The widget settings are invalid."],
      "fine",
      [
        "Flow",
        'Unknown query kind "pie". The kinds are: metric, flow, step_flow, funnel, clusters, geography, sql.',
      ],
      ["Widget 4", "The widget settings are invalid."],
      ["Twice", "Another widget has the same id."],
      ["Widget 6", "The widget is not an object."],
    ],
  );
  assert.deepEqual(read[1], fine, "a good one is untouched");
  assert.deepEqual(read[2].layout, place, "a good place is kept");
  assert.equal(new Set(read.map((item) => item.id)).size, 6);
  for (const { layout } of read) assert.ok(gridPositionSchema.safeParse(layout).success);

  const asked: string[] = [];
  const results = await loadWidgets(
    PROJECT,
    read,
    { since: new Date("2026-11-02"), until: new Date("2026-11-03") },
    { customMonitoring: true },
    async (projectId, item, scope) => {
      asked.push(item.title);
      return runQuery(projectId, item.query as MetricQuery, scope, db as unknown as MetricsDb);
    },
  );
  assert.deepEqual(asked, ["fine"]);
  assert.deepEqual(
    results.map((result) => result !== null),
    [false, true, false, false, false, false],
  );
  assert.deepEqual(
    exportDashboard({ name: "Board", filters: {}, range: null, widgets: read }, []).widgets.map(
      ({ title }) => title,
    ),
    ["fine"],
  );

  // A change of another widget writes the broken ones back as they were; Remove removes one.
  await ok({ action: "remove-widget", dashboardId: id, widgetId: "r1" });
  const { rows } = await client.query<{ widgets: Record<string, unknown>[] }>(
    "select widgets from dashboards where id = $1",
    [id],
  );
  assert.equal(rows[0].widgets.length, 5);
  assert.deepEqual(rows[0].widgets[1].query, { ...WIDGET.query, kind: "pie" });
  const left = (await getDashboard(PROJECT, id, db))?.widgets ?? [];
  // "Twice" has an id of its own now, so it is whole.
  assert.equal(left.filter(isBroken).length, 3);
  for (const { id: widgetId } of left.filter(isBroken))
    await ok({ action: "remove-widget", dashboardId: id, widgetId });
  assert.deepEqual((await titles(id)).sort(), ["Twice", "fine"]);
});

test("the starter set is four valid widgets", async () => {
  const result = await run({ action: "create-starter" });
  assert.ok(result.ok);
  const stored = await widgets(result.dashboardId);
  assert.equal(stored.length, 4);
  assert.equal(new Set(stored.map((widget) => widget.id)).size, 4);
  for (const widget of STARTER_WIDGETS) assert.ok(parseWidget(widget).ok);
});

test("the filters and the range a dashboard opens with are saved with who saved them", async () => {
  const id = await created();
  const defaults = { filters: { environments: ["prod"], agents: ["planner"] }, range: "30d" };
  await ok({ action: "save-defaults", dashboardId: id, defaults });
  const [listed] = await listDashboards(PROJECT, db);
  assert.deepEqual(
    [listed.name, listed.filters, listed.range, listed.updatedByName, listed.widgetCount],
    ["Board", defaults.filters, "30d", "Ada", 0],
  );
  const bad = [
    { filters: { tools: ["a"] }, range: null },
    { filters: {}, range: "1h" },
    { filters: { models: [""] }, range: null },
    null,
  ];
  for (const wrong of bad)
    await refused({ action: "save-defaults", dashboardId: id, defaults: wrong }, /invalid/);
});

test("a dashboard filter narrows every widget, on top of its own filter", async () => {
  const at = "2026-11-02T10:00:00Z";
  const insert = (id: string, models: string, environment: string) =>
    client.query(
      `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
         input_tokens, output_tokens, cost_usd, models, environment, spans_max_received_at, updated_at)
       values ($1, $2, $3, 500, false, 1, 1, 0, $4, $5, $3, $3)`,
      [PROJECT, id, at, models, environment],
    );
  await insert("t1", "{gpt}", "prod");
  await insert("t2", "{gpt,haiku}", "prod");
  await insert("t3", "{haiku}", "staging");
  const shown = [
    metricQuery("trace_count", "count"),
    metricQuery("trace_count", "count", { filters: { models: ["gpt"] } }),
    metricQuery("trace_count", "count", { dimensions: ["environment"] }),
    metricQuery("context_tokens", "sum"),
  ].map((query, index) => ({
    ...WIDGET,
    query,
    id: String(index),
    layout: { x: 0, y: 6 * index, w: 6, h: 6 },
  }));
  const totals = async (filter?: DashboardFilters) =>
    (
      await loadWidgets(
        PROJECT,
        shown,
        { since: new Date("2026-11-02"), until: new Date("2026-11-03"), filter },
        { customMonitoring: false },
        (projectId, widget, scope) =>
          runQuery(projectId, widget.query as MetricQuery, scope, db as unknown as MetricsDb),
      )
    ).map((result) => seriesOf(result)?.map(({ total }) => total));
  assert.deepEqual(await totals(), [[3], [2], [2, 1], [0]]);
  assert.deepEqual(await totals({ environments: ["prod"] }), [[2], [2], [2], [0]]);
  // Both must match: only t2 has both models.
  assert.deepEqual(await totals({ models: ["haiku"] }), [[2], [1], [1, 1], [0]]);
  assert.deepEqual(await totals({ models: ["haiku"], environments: ["prod"] }), [
    [1],
    [1],
    [1],
    [0],
  ]);
});

test("export, then import into another project, gives an equal dashboard", async () => {
  const on = { features: async () => ({ customMonitoring: true }) };
  const mine = [
    { id: OTHER, name: "Polite", verdict: true },
    { id: ORG, name: "Depth", verdict: false },
  ];
  const theirs = [{ id: PROJECT, name: "Polite", verdict: true }];
  const id = await created("Support");
  await ok({
    action: "save-defaults",
    dashboardId: id,
    defaults: { filters: { environments: ["prod"] }, range: "30d" },
  });
  const shown: WidgetInput[] = [
    WIDGET,
    scorerWidget(mine[0]),
    { ...scorerWidget(mine[1]), title: "Depth of answers" },
    {
      title: "",
      query: metricQuery("cost", "sum", { dimensions: ["model", "service"], bucket: "day" }),
      chart: "table",
    },
  ];
  for (const widget of shown)
    assert.ok((await run({ action: "add-widget", dashboardId: id, widget }, on)).ok);
  const source = await getDashboard(PROJECT, id, db);
  assert.ok(source);
  const document = exportDashboard(source, mine);
  const json = JSON.stringify(document);
  for (const secret of [PROJECT, OTHER, ORG, id, ...source.widgets.map((item) => item.id)])
    assert.ok(!json.includes(secret), "no database id leaves");
  assert.ok(dashboardDocumentSchema.safeParse(JSON.parse(json)).success);

  const result = await run(
    { projectId: OTHER, action: "import", document: JSON.parse(json) },
    { ...on, scorers: async () => theirs },
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.missingScorers, ["Depth"]);
  const copy = await getDashboard(OTHER, result.dashboardId, db);
  assert.ok(copy);
  // Equal to the source, a missing scorer included, whoever exports it.
  assert.deepEqual(exportDashboard(copy, theirs), document);
  const [, polite, depth] = copy.widgets.filter(isWidget);
  assert.deepEqual(queryScorerId(polite.query), PROJECT);
  assert.deepEqual([depth.missingScorer, queryScorerId(depth.query)], ["Depth", undefined]);

  // Edited, it is whole again.
  const fixed = { title: "", query: depth.query, chart: depth.chart };
  const edit = { action: "edit-widget", dashboardId: copy.id, widgetId: depth.id, widget: fixed };
  assert.ok((await run({ projectId: OTHER, ...edit }, on)).ok);
  const whole = (await getDashboard(OTHER, copy.id, db))?.widgets[2];
  assert.ok(whole && !isBroken(whole));
  assert.equal(whole.missingScorer, undefined);
});

test("context data of two environments stays whole under a dashboard filter; a trace widget does not", async () => {
  await client.exec("delete from otel_trace_summaries");
  const at = "2026-11-12T10:00:00Z";
  for (const [traceId, environment, tokens] of [
    ["c1", "prod", 10],
    ["c2", "staging", 5],
  ] as const) {
    await client.query(
      `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
         input_tokens, output_tokens, cost_usd, environment, spans_max_received_at, updated_at)
       values ($1, $2, $3, 500, false, 1, 1, 0, $4, $3, $3)`,
      [PROJECT, traceId, at, environment],
    );
    const event = await client.query<{ id: string }>(
      `insert into events (project_id, occurred_at, dedupe_hash, trace_id)
       values ($1, $2, $3, $3) returning id`,
      [PROJECT, at, traceId],
    );
    await client.query(
      `insert into event_metrics (event_id, project_id, event_time, tokens_by_category, splits, categorizer_version)
       values ($1, $2, $3, $4, '{}', 1)`,
      [event.rows[0].id, PROJECT, at, { tools: tokens }],
    );
  }
  const shown = [metricQuery("context_tokens", "sum"), metricQuery("trace_count", "count")].map(
    (query, index) => ({
      ...WIDGET,
      query,
      id: String(index),
      layout: { x: 0, y: 6 * index, w: 6, h: 6 },
    }),
  );
  const totals = async (filter?: DashboardFilters) =>
    (
      await loadWidgets(
        PROJECT,
        shown,
        { since: new Date("2026-11-12"), until: new Date("2026-11-13"), filter },
        { customMonitoring: false },
        (projectId, item, scope) =>
          runQuery(projectId, item.query as MetricQuery, scope, db as unknown as MetricsDb),
      )
    ).map((result) => seriesOf(result)?.[0].total);
  assert.deepEqual(await totals(), [15, 2]);
  assert.deepEqual(await totals({ environments: ["prod"] }), [15, 1]);
  assert.deepEqual(await totals({ environments: ["staging"] }), [15, 1]);
});

test("a widget that does not fit the metric catalog or its chart is refused", async () => {
  const id = await created();
  const bad: [Record<string, unknown>, RegExp][] = [
    [query({ measures: [{ measure: "nope", aggregation: "sum" }] }), /Unknown measure/],
    [query({ measures: [{ measure: "latency", aggregation: "sum" }] }), /cannot be aggregated/],
    [query({ kind: "pie" }), /Unknown query kind/],
    [query({ version: 9 }), /Unknown query version/],
    [{ query: undefined }, /Unknown query kind/],
    [{ chart: "table" }, /needs a group-by/],
    [{ chart: "number", ...query({ dimensions: ["model"] }) }, /cannot be grouped/],
    [{ chart: "pie" }, /invalid/],
    [{ size: "half" }, /invalid/],
    [{ metric: "latency" }, /invalid/],
    [query({ filters: { sql: "1=1" } }), /invalid/],
    [{ title: "x".repeat(81) }, /invalid/],
  ];
  for (const [change, error] of bad) {
    const widget = { ...WIDGET, ...change };
    await refused({ action: "add-widget", dashboardId: id, widget }, error);
  }
  await refused({ action: "add-widget", dashboardId: id }, /invalid/);
  assert.deepEqual(await widgets(id), []);
});

test("a sql widget: saved, loaded, refused by RQL, exported and imported", async () => {
  metricSeams.sql = sqlQueryRunner({
    run: {
      executor: createPgRqlExecutor(pglitePoolOf(client)),
      gate: createRqlGate(),
      observe: async () => {},
    },
  });
  const id = await created("RQL");
  const widget: WidgetInput = {
    title: "Traces",
    query: sqlWidgetQuery("select count(*) as traces from traces"),
    chart: "sql",
  };
  await refused(
    { action: "add-widget", dashboardId: id, widget: { ...widget, chart: "table" } },
    /drawn as chart "sql"/,
  );
  assert.ok((await run({ action: "add-widget", dashboardId: id, widget })).ok);
  const [stored] = await widgets(id);
  assert.deepEqual(stored, { ...widget, id: stored.id, layout: stored.layout });

  const scope = {
    since: new Date(Date.now() - 3_600_000),
    until: new Date(),
    filter: { environments: ["prod"] },
  };
  const result = await loadWidget(PROJECT, stored, scope, db as never);
  assert.deepEqual(result, {
    kind: "sql",
    columns: [{ name: "traces", type: "integer" }],
    rows: [[0]],
    truncated: false,
  });
  const wrong = { ...stored, query: sqlWidgetQuery("select * from spans") };
  const refusal = await loadWidget(PROJECT, wrong, scope, db as never);
  assert.equal(refusal?.kind, "refused");
  assert.ok(refusal?.kind === "refused" && refusal.code === "unknown_table" && refusal.fix);

  const source = await getDashboard(PROJECT, id, db);
  assert.ok(source);
  const document = exportDashboard(source, []);
  assert.deepEqual(document.widgets[0].query, widget.query);
  const imported = await run({ projectId: OTHER, action: "import", document });
  assert.ok(imported.ok, JSON.stringify(imported));
  const copy = await getDashboard(OTHER, imported.dashboardId, db);
  assert.ok(copy);
  assert.deepEqual(exportDashboard(copy, []), document);
});

test("a scorer widget is accepted with customMonitoring only", async () => {
  const id = await created();
  const widget = scorerWidget({ id: OTHER, verdict: true });
  await refused({ action: "add-widget", dashboardId: id, widget }, /is off/);
  const on = { features: async () => ({ customMonitoring: true }) };
  assert.ok((await run({ action: "add-widget", dashboardId: id, widget }, on)).ok);
  const [stored] = await widgets(id);
  assert.deepEqual(stored, { ...widget, id: stored.id, layout: stored.layout });
  await refused({ action: "edit-widget", dashboardId: id, widgetId: stored.id, widget }, /is off/);
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ filters: { scorer: { id: "nope" } } }, /Unknown scorer/],
    [{ dimensions: ["tool"] }, /be grouped/],
    [{ measures: [{ measure: "trace_count", aggregation: "count" }] }, /filtered by scorer/],
  ];
  for (const [change, error] of bad) {
    const changed = { ...widget, query: { ...widget.query, ...change } };
    await refused({ action: "add-widget", dashboardId: id, widget: changed }, error, on);
  }
});

test("leaving the scorer metrics drops the scorer; each metric offers the scorers it reads", () => {
  const widget = scorerWidget({ id: OTHER, verdict: false });
  assert.equal(widget.query.measures[0].measure, "scorer_average");
  const mine = [{ id: OTHER, name: "Depth", verdict: false }];
  const scorerAfter = (measure: MeasureId) =>
    changeQuery(widget.query, { measure }, mine).filters.scorer;
  assert.deepEqual(scorerAfter("scorer_count"), { id: OTHER });
  assert.equal(scorerAfter("cost"), undefined);
  assert.equal(scorerAfter("scorer_pass_rate"), undefined);
  const scorers = [
    { id: "a", name: "A", verdict: true },
    { id: "b", name: "B", verdict: false },
  ];
  const ids = (metric: MeasureId) => scorersOfMetric(metric, scorers).map(({ id }) => id);
  assert.deepEqual(ids("scorer_pass_rate"), ["a"]);
  assert.deepEqual(ids("scorer_average"), ["b"]);
  assert.deepEqual(ids("scorer_count"), ["a", "b"]);
});

test("a caller without project access, the flag, a session or write access changes nothing", async () => {
  const id = await created();
  const denials: [Partial<DashboardActionDeps>, RegExp][] = [
    [{ findProjectScope: async () => null }, /cannot change this project/],
    [{ enabled: async () => false }, /are off/],
    [{ getSession: async () => null }, /Sign in/],
    [{ isRestricted: async () => true }, /support session/],
  ];
  for (const [deps, error] of denials) {
    await refused({ action: "create", name: "New" }, error, deps);
    await refused({ action: "delete", dashboardId: id }, error, deps);
    await refused({ action: "add-widget", dashboardId: id, widget: WIDGET }, error, deps);
  }
  assert.equal((await listDashboards(PROJECT, db)).length, 1);
  assert.deepEqual(await widgets(id), []);
});

test("another project's dashboard cannot be read or changed", async () => {
  const id = await created();
  const other = { projectId: OTHER, dashboardId: id };
  assert.equal(await getDashboard(OTHER, id, db), null);
  await refused({ ...other, action: "rename", name: "Mine" }, /no longer exists/);
  await refused({ ...other, action: "delete" }, /no longer exists/);
  await refused({ ...other, action: "add-widget", widget: WIDGET }, /no longer exists/);
  assert.equal((await getDashboard(PROJECT, id, db))?.name, "Board");
});

test("an invalid request is refused", async () => {
  const id = await created();
  await refused({ action: "create", name: "  " }, /a name/);
  await refused({ action: "create", name: "x".repeat(81) }, /80 characters/);
  await refused({ action: "rename", dashboardId: "nope", name: "x" }, /invalid/);
  await refused({ action: "drop", dashboardId: id }, /invalid/);
  for (const layouts of [null, { x: { x: 9, y: 0, w: 6, h: 6 } }, { x: "left" }])
    await refused({ action: "save-layout", dashboardId: id, layouts }, /invalid/);
  assert.deepEqual(await changeDashboard(null, deps()), {
    ok: false,
    error: "The dashboard change is invalid.",
  });
});

const CLUSTERS = { version: 1, kind: "clusters", view: "asks" } as const;
/** Two lists of a clusters query, as much over the budget of one filter as `bytes` says. */
function clustersOf(bytes: number) {
  const lists = (text: string) => ({ tools: ["t".repeat(1_900), text], tasks: ["task"] });
  return { ...CLUSTERS, ...lists("x".repeat(bytes - JSON.stringify(lists("")).length)) };
}

test("F445-6: a clusters query over the filter budget is refused on save and on import", async () => {
  const id = await created();
  const add = (bytes: number) => ({
    action: "add-widget",
    dashboardId: id,
    widget: { title: "", query: clustersOf(bytes), chart: "clusters" },
  });
  const document = (bytes: number) => ({
    action: "import",
    document: {
      type: "ratel.dashboard",
      version: 1,
      name: "Map",
      widgets: [
        { query: clustersOf(bytes), chart: "clusters", layout: { x: 0, y: 0, w: 6, h: 6 } },
      ],
    },
  });
  const tooLong = /The filters are too long: 3,073 bytes of JSON, 3,072 at most\./;
  for (const input of [add, document]) {
    await ok(input(3_072));
    await refused(input(3_073), tooLong);
  }
});

test("F445-6: the list and the limit read counts, never the widgets", async () => {
  const id = await created();
  for (let n = 0; n < 2; n++)
    await ok({
      action: "add-widget",
      dashboardId: id,
      widget: { ...WIDGET, title: "in-the-body" },
    });
  await client.exec(
    `insert into dashboards (project_id, name, widgets, updated_by) values ('${PROJECT}', 'Odd', '{}', 'u')`,
  );
  const read: string[] = [];
  const listening = drizzle(client, {
    schema,
    logger: { logQuery: (text) => read.push(text) },
  }) as unknown as DashboardsDb;
  const listed = await listDashboards(PROJECT, listening);
  assert.deepEqual(
    listed.map(({ name, widgetCount }) => [name, widgetCount]),
    [
      ["Board", 2],
      ["Odd", 0],
    ],
  );
  assert.equal(await countDashboards(PROJECT, listening), 2);
  assert.ok(!JSON.stringify(listed).includes("in-the-body"));
  for (const text of read) assert.ok(!/(^select|,) "widgets"/.test(text), text);
});

test("F445-7: a NUL character in a name, a title or a filter is refused, and nothing is thrown", async () => {
  const id = await created();
  const bad = /NUL character/;
  const nul = "a\u0000b";
  await refused({ action: "create", name: nul }, bad);
  await refused({ action: "rename", dashboardId: id, name: nul }, bad);
  const add = (change: object, more = {}) => ({
    action: "add-widget",
    dashboardId: id,
    widget: { ...WIDGET, ...change },
    ...more,
  });
  await refused(add({ title: nul }), bad);
  await refused(add(query({ filters: { models: [nul] } })), bad);
  await refused(add({}, { missingScorer: nul }), bad);
  const defaults = { filters: { models: [nul] }, range: null };
  await refused({ action: "save-defaults", dashboardId: id, defaults }, bad);
  let deep: unknown = [];
  for (let n = 0; n < 20_000; n++) deep = [deep];
  const result = await run({
    action: "save-defaults",
    dashboardId: id,
    defaults: { filters: deep, range: null },
  });
  assert.ok(!result.ok && /invalid/.test(result.error));
  assert.deepEqual(await widgets(id), []);
});

test("a dashboard holds at most 24 widgets", async () => {
  const id = await created();
  for (let index = 0; index < MAX_WIDGETS; index += 1)
    await ok({ action: "add-widget", dashboardId: id, widget: WIDGET });
  await refused({ action: "add-widget", dashboardId: id, widget: WIDGET }, /24 widgets/);
});

test("the editor stays on a widget the rules allow", () => {
  const fit = (change: object) => fitWidget({ ...WIDGET, ...change });
  assert.deepEqual(fit({ chart: "table" }).query.dimensions, ["model"]);
  assert.deepEqual(
    fit({ chart: "number", ...query({ dimensions: ["model"] }) }).query.dimensions,
    [],
  );
  const cost = changeQuery(WIDGET.query, { measure: "cost" }, []);
  assert.deepEqual(cost, metricQuery("cost", "sum", { filters: WIDGET.query.filters }));
  const context = changeQuery(
    metricQuery("cost", "sum", {
      dimensions: ["model"],
      bucket: "hour",
      filters: { models: ["a"] },
    }),
    { measure: "context_tokens" },
    [],
  );
  assert.deepEqual(context, metricQuery("context_tokens", "sum"));
  const table = fit({ chart: "table", query: context });
  assert.equal(table.chart, "line");
  for (const widget of [fit({ chart: "table" }), fit({ query: cost }), table])
    assert.ok(parseWidget(widget).ok);
});

test("a widget is named after what it measures until it has a title", () => {
  const named = (...args: Parameters<typeof metricQuery>) =>
    widgetName({ title: "", query: metricQuery(...args) });
  assert.equal(named("latency", "p95"), "Latency p95");
  assert.equal(
    named("latency", "p95", { dimensions: ["model", "service"] }),
    "Latency p95 by model and service",
  );
  assert.equal(named("cost", "sum"), "Cost");
  assert.equal(named("cost", "avg"), "Cost per trace");
  assert.equal(widgetName({ ...WIDGET, title: "Speed" }), "Speed");
});

function deps(overrides: Partial<DashboardActionDeps> = {}): DashboardActionDeps {
  return {
    getSession: async () => ({
      user: { id: "user-1", externalId: "ext-1", name: "Ada", username: null, email: null },
    }),
    findProjectScope: async (projectId) => ({
      project: { id: projectId },
      organization: { id: ORG },
    }),
    enabled: async () => true,
    features: async () => ({ customMonitoring: false }),
    scorers: async () => [],
    isRestricted: async () => false,
    store: {
      createDashboard: (input) => createDashboard(input, db),
      updateDashboard: (input) => updateDashboard(input, db),
      deleteDashboard: (projectId, id) => deleteDashboard(projectId, id, db),
      changeWidgets: (input) => changeWidgets(input, db),
    },
    observe: async () => {},
    ...overrides,
  };
}

function run(input: object, overrides?: Partial<DashboardActionDeps>) {
  return changeDashboard({ projectId: PROJECT, ...input }, deps(overrides));
}

async function ok(input: object) {
  const result = await run(input);
  assert.ok(result.ok, JSON.stringify(result));
}

async function refused(input: object, error: RegExp, overrides?: Partial<DashboardActionDeps>) {
  const result = await run(input, overrides);
  assert.ok(!result.ok, JSON.stringify(input));
  assert.match(result.error, error);
}

async function created(name = "Board"): Promise<string> {
  const result = await run({ action: "create", name });
  assert.ok(result.ok);
  return result.dashboardId;
}

async function widgets(id: string) {
  const dashboard = await getDashboard(PROJECT, id, db);
  assert.ok(dashboard);
  return dashboard.widgets.filter(isWidget);
}

async function widget(id: string, widgetId: string) {
  return (await widgets(id)).find((item) => item.id === widgetId);
}

async function titles(id: string) {
  return inReadingOrder(await widgets(id)).map((item) => item.title);
}

function seriesOf(result: WidgetResult | null) {
  return result?.kind === "metric" ? result.series : undefined;
}
