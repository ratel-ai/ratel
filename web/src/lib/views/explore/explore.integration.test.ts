import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { type MetricQuery, metricQuery, type SqlQuery } from "@/lib/contracts/query";
import { insertOtelSpans } from "@/lib/ingest/otlp/queries";
import type { NewOtelSpan } from "@/lib/ingest/otlp/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import {
  type MetricsDb,
  metricSeams,
  type QueryResult,
  runQuery,
} from "@/lib/synthesis/metrics/query";
import { createPgRqlExecutor } from "@/lib/synthesis/rql/adapters/pg-executor";
import { sqlQueryRunner } from "@/lib/synthesis/rql/query";
import { createRqlGate } from "@/lib/synthesis/rql/run";
import { pglitePoolOf } from "@/lib/synthesis/rql/tests/test-support";
import { getTraceAggregates, listTraces } from "@/lib/synthesis/traces/queries";
import { refreshTraceSummaries } from "@/lib/synthesis/traces/summary-refresh";
import { withClause } from "@/lib/synthesis/traces/trace-filter-clauses";
import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import { traceFilterFromSearch, withoutRollupFilters } from "@/lib/synthesis/traces/v2/filters";
import { resolveTraceListView, resolveTraceRange } from "@/lib/synthesis/traces/view";
import {
  alertQueryOf,
  IN_FRAGMENT,
  NEW_ALERT_PARAM,
  newAlertHref,
  PAGE_FILTERS_PARAM,
} from "@/lib/views/alerts/links";
import { parseAlertQuery } from "@/lib/views/alerts/parse-rule";
import { measureSqlValue } from "@/lib/views/alerts/sql-value";
import { changeDashboard, type DashboardActionDeps } from "@/lib/views/dashboards/actions";
// The modules that run the kinds register with it.
import { loadWidget } from "@/lib/views/dashboards/data";
import { takesPageFilters, withPageFilters } from "@/lib/views/dashboards/filters";
import { widgetTracesHref } from "@/lib/views/dashboards/links";
import { exactly } from "@/lib/views/dashboards/range";
import * as store from "@/lib/views/dashboards/store";
import { isWidget } from "@/lib/views/dashboards/stored-widget";
import {
  type DashboardFilters,
  WIDGET_KINDS,
  type WidgetResult,
} from "@/lib/views/dashboards/types";
import { metricOfForm, queryFilter, widgetOfKind, withFilter } from "@/lib/views/dashboards/widget";
import { START_PANEL } from "@/lib/views/explore/starts";
import { decodePanels, encodePanels } from "@/lib/views/explore/state";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const FEATURES = { customMonitoring: true };

const NOON = "2026-11-24T12:00:00.000Z";
const HOUR = {
  preset: "exact",
  from: NOON,
  to: "2026-11-24T13:00:00.000Z",
  since: new Date(NOON),
  until: new Date("2026-11-24T13:00:00.000Z"),
};
/** Their index is their id. */
const TRACES = ["before", "start", "both", "x", "staging", "end"];

let client: Awaited<ReturnType<typeof createMigratedPGlite>>;
let db: MetricsDb & store.DashboardsDb;

before(async () => {
  client = await createMigratedPGlite();
  db = drizzle(client, { schema }) as unknown as typeof db;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent');
  `);
  const times = ["11:59:59.999", "12:00:00", "12:10:00", "12:20:00", "12:30:00", "13:00:00"];
  await insertOtelSpans(
    PROJECT,
    times.map((time, index) =>
      span({ spanId: idOf(index).slice(16), traceId: idOf(index), startedAt: at(time) }),
    ),
    db as never,
  );
  await refreshTraceSummaries({ visibilityLagMs: 0 }, db as never);
  // A saved metric widget is RQL: it reads on the RQL path, over the same database.
  metricSeams.sql = sqlQueryRunner({
    run: {
      executor: createPgRqlExecutor(pglitePoolOf(client)),
      gate: createRqlGate(),
      observe: async () => {},
    },
  });
  const summary = (index: number, values: string) =>
    `update otel_trace_summaries set ${values} where trace_id = '${idOf(index)}';`;
  await client.exec(
    [
      summary(1, "environment = 'prod', agents = '{c}'"),
      summary(2, "environment = 'prod', agents = '{a,b}', models = '{m,n}', tools = '{t,u}'"),
      summary(
        3,
        "environment = 'prod', agents = '{a}', models = '{m}', tools = '{t}', has_error = true",
      ),
      summary(4, "environment = 'staging', agents = '{b}', models = '{n}', tools = '{u}'"),
    ].join("\n"),
  );
});
after(() => client.close());

test("a panel of each kind runs, and saves as an equal widget", async () => {
  const id = await change({ action: "create", name: "Board" });
  const range = resolveTraceRange({}, new Date());
  // Kind sql runs on the RQL path: `dashboards.integration.test.ts` saves and reads it.
  for (const kind of WIDGET_KINDS.filter((kind) => kind !== "sql")) {
    const decoded = decodePanels(encodePanels([widgetOfKind(kind, START_PANEL)]));
    assert.ok(decoded.ok);
    const [panel] = decoded.panels;
    assert.equal((await runQuery(PROJECT, panel.query, range, db)).kind, kind);
    await change({ action: "add-widget", dashboardId: id, widget: panel });
    const board = await store.getDashboard(PROJECT, id, db);
    const widgets = (board?.widgets ?? []).filter(isWidget).map(({ title, query, chart }) => ({
      title,
      query,
      chart,
    }));
    assert.ok(
      widgets.some((widget) => isSame(widget, panel)),
      kind,
    );
  }
});

test("the saved widget, the alert and the trace link read the rows the panel showed", async () => {
  const cases: [string, TraceFilter, DashboardFilters, string[]][] = [
    ["no filter", {}, {}, ["start", "both", "x", "staging"]],
    ["disjoint scalar", { environments: ["prod"] }, { environments: ["staging"] }, []],
    [
      "one scalar in common",
      { environments: ["prod", "a"] },
      { environments: ["prod"] },
      ["start", "both", "x"],
    ],
    ["disjoint values of many", { agents: ["a"] }, { agents: ["b"] }, ["both"]],
    [
      "one value of many in common",
      { agents: ["a", "c"] },
      { agents: ["b", "c"] },
      ["start", "both"],
    ],
    ["disjoint models", { models: ["m"] }, { models: ["n"] }, ["both"]],
    ["another property", { tools: ["t"] }, { agents: ["b"] }, ["both"]],
    ["disjoint clauses of its own", { tools: ["t"], and: [{ tools: ["u"] }] }, {}, ["both"]],
    ["with a status", { status: "failed" }, { agents: ["a"] }, ["x"]],
  ];
  const dashboardId = await change({ action: "create", name: "Equal" });
  for (const [name, filters, page, expected] of cases) {
    const query = metricQuery("trace_count", "count", {
      filters: filters as MetricQuery["filters"],
    });
    const shown = await runQuery(PROJECT, query, { ...HOUR, filter: page }, db);
    assert.equal(totalOf(shown), expected.length, name);

    const merged = withPageFilters(query, page);
    const widget = { title: name, query: merged, chart: "line" };
    await change({ action: "add-widget", dashboardId, widget });
    const stored = (await store.getDashboard(PROJECT, dashboardId, db))?.widgets.at(-1);
    assert.ok(stored && isWidget(stored));
    // The saved widget runs its RQL text: the same number as the panel showed.
    const saved = await loadWidget(PROJECT, stored, HOUR, db as never);
    assert.equal(sumOf(saved), expected.length, name);

    // The rule runs its RQL text, as the evaluator does: the same number as the panel showed.
    const rule = alertRuleOf(newAlertHref(PROJECT, merged, takesPageFilters(query, page)));
    assert.deepEqual(await measureSqlValue(PROJECT, rule, HOUR), { value: expected.length }, name);

    const href = widgetTracesHref(PROJECT, withClause(queryFilter(query), page), HOUR);
    assert.deepEqual(
      await tracesOf(href),
      expected.map((each) => TRACES.indexOf(each)).sort(),
      name,
    );
  }
});

test("each kind reads the same saved with the page's filters as under them", async () => {
  const page = { agents: ["b"] };
  for (const kind of ["flow", "step_flow", "funnel", "geography"] as const) {
    const { query } = widgetOfKind(kind, START_PANEL);
    const own = withFilter(query, { agents: ["a"] });
    const shown = await runQuery(PROJECT, own, { ...HOUR, filter: page }, db);
    assert.deepEqual(await runQuery(PROJECT, withPageFilters(own, page), HOUR, db), shown, kind);
  }
});

test("View traces of 12:00 to 13:00 has the trace at its start and none at or after its end", async () => {
  const range = exactly(HOUR.since, HOUR.until);
  const ids = await tracesOf(widgetTracesHref(PROJECT, {}, range));
  assert.deepEqual(ids.map((id) => TRACES[id]).sort(), ["both", "staging", "start", "x"]);
  const day = { preset: "custom", from: "2026-11-24", to: "2026-11-24" };
  const all = await tracesOf(widgetTracesHref(PROJECT, {}, day));
  assert.equal(all.length, TRACES.length);
});

test("a trace is in an exact window by its start, as in the panel", async () => {
  await db
    .transaction(async (tx) => {
      // It has a root in the hour, and its first one is before.
      await insertOtelSpans(
        PROJECT,
        [
          span({ spanId: "e".repeat(16), traceId: idOf(60), startedAt: at("12:30:00") }),
          span({
            spanId: "f".repeat(16),
            traceId: idOf(60),
            startedAt: at("11:59:00"),
          }),
        ],
        tx as never,
      );
      await refreshTraceSummaries({ visibilityLagMs: 0 }, tx as never);
      const range = exactly(HOUR.since, HOUR.until);
      const query = metricQuery("trace_count", "count");
      const href = widgetTracesHref(PROJECT, {}, range);
      assert.equal(totalOf(await runQuery(PROJECT, query, HOUR, tx as never)), 4);
      assert.equal((await tracesOf(href, tx as never)).length, 4);
      tx.rollback();
    })
    .catch((error) => {
      if (!/rollback/i.test(String(error))) throw error;
    });
});

test("Save and Create alert take a long tool list and the page's filters, and say what they include", async () => {
  const tools = Array.from({ length: 130 }, (_, index) => `a-long-tool-name-${index}`);
  const query = metricQuery("latency", "p95", { filters: { tools } });
  const page = { agents: ["a"], models: ["m"] };
  const href = newAlertHref(PROJECT, withPageFilters(query, page), takesPageFilters(query, page));
  assert.deepEqual(alertOf(href).filters, { tools, and: [{ agents: ["a"], models: ["m"] }] });
  const said = (filters: object, of: MetricQuery = query) =>
    new URL(
      newAlertHref(PROJECT, withPageFilters(of, filters), takesPageFilters(of, filters)),
      "https://x.test",
    ).searchParams.get(PAGE_FILTERS_PARAM);
  assert.equal(said(page), "1");
  for (const [filters, of] of [
    [{}, query],
    [{ models: ["m"] }, metricQuery("latency", "p95", { filters: { models: ["m"] } })],
    [page, metricQuery("context_cost", "sum")],
  ] as const)
    assert.equal(said(filters, of), null);
});

test("a link of the form before this one still opens", () => {
  const query = metricQuery("latency", "p95", { filters: { services: ["web"] } });
  const params = new URLSearchParams({ [NEW_ALERT_PARAM]: JSON.stringify(query) });
  assert.deepEqual(alertOf(`/new?${params}`), query);
});

test("Create alert opens the form with the panel's metric and filter", () => {
  const query = metricQuery("error_rate", "rate", {
    dimensions: ["model"],
    filters: { services: ["web"] },
    bucket: "day",
  });
  assert.deepEqual(
    alertOf(newAlertHref(PROJECT, query)),
    metricQuery("error_rate", "rate", { filters: { services: ["web"] } }),
  );
});

/** The metric of the form the alert form opens with. */
function alertOf(href: string): MetricQuery {
  const { form } = alertRuleOf(href);
  assert.ok(form);
  return metricOfForm(form);
}

/** The rule the alert form opens with: its RQL text, with the form's selection. */
function alertRuleOf(href: string): SqlQuery {
  const { searchParams, hash } = new URL(href, "https://x.test");
  const value = searchParams.get(NEW_ALERT_PARAM) ?? "";
  const parsed = parseAlertQuery(
    alertQueryOf(value === IN_FRAGMENT ? hash.slice(1) : value),
    FEATURES,
  );
  // An alert keeps its metric as the form of its RQL.
  assert.ok(parsed.ok && parsed.query.form);
  return parsed.query;
}

/** What the Traces page lists and counts for an address. */
async function tracesOf(href: string, of: typeof db = db): Promise<number[]> {
  const { search } = new URL(href, "https://x.test");
  const view = resolveTraceListView(
    // The rollup filters are not the span filters of the same name, as on the page.
    Object.fromEntries(new URLSearchParams(withoutRollupFilters(search, { entities: true }))),
    new Date(NOON),
  );
  const options = {
    ...view.queryOptions,
    since: view.range.since,
    until: view.range.until,
    traces: traceFilterFromSearch(search, { entities: true }),
  };
  const { items } = await listTraces(PROJECT, options, of as never);
  assert.equal((await getTraceAggregates(PROJECT, options, of as never)).count, items.length);
  return items.map(({ traceId }) => Number.parseInt(traceId, 16) - 1).sort();
}

/** The sum of the number column of an RQL result. */
function sumOf(result: WidgetResult | null): number {
  assert.ok(result?.kind === "sql", JSON.stringify(result));
  const at = result.columns.findIndex(({ name }) => name === "value");
  return result.rows.reduce((sum, row) => sum + Number(row[at] ?? 0), 0);
}

function totalOf(result: QueryResult): number {
  assert.ok(result.kind === "metric");
  return result.series[0]?.total ?? 0;
}

function idOf(index: number): string {
  return (index + 1).toString(16).padStart(32, "0");
}

function at(time: string): Date {
  return new Date(`2026-11-24T${time}Z`);
}

function span(of: Partial<NewOtelSpan>): NewOtelSpan {
  const startedAt = of.startedAt ?? at("12:00:00");
  return {
    id: randomUUID(),
    projectId: PROJECT,
    name: "run",
    kind: 1,
    spanClass: "other",
    endedAt: startedAt,
    durationMs: 0,
    statusCode: 0,
    attributes: {},
    experimentAttrs: {},
    attrsTruncated: false,
    receivedAt: new Date(Date.now() - 60_000),
    ...of,
  } as NewOtelSpan;
}

function isSame(a: unknown, b: unknown): boolean {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

async function change(input: object): Promise<string> {
  const result = await changeDashboard({ projectId: PROJECT, ...input }, {
    getSession: async () => ({
      user: { id: "u", externalId: "u", name: "Ada", username: null, email: null },
    }),
    findProjectScope: async () => ({ project: { id: PROJECT }, organization: { id: ORG } }),
    enabled: async () => true,
    features: async () => FEATURES,
    scorers: async () => [],
    isRestricted: async () => false,
    store: {
      createDashboard: (input) => store.createDashboard(input, db),
      updateDashboard: (input) => store.updateDashboard(input, db),
      deleteDashboard: (projectId, id) => store.deleteDashboard(projectId, id, db),
      changeWidgets: (input) => store.changeWidgets(input, db),
    },
    observe: async () => {},
  } as DashboardActionDeps);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.dashboardId;
}
