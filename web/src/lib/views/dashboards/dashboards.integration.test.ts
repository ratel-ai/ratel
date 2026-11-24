import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import type { MetricId } from "@/lib/synthesis/metrics/catalog";
import { changeDashboard, type DashboardActionDeps } from "@/lib/views/dashboards/actions";
import { parseWidget } from "@/lib/views/dashboards/parse-widget";
import { STARTER_WIDGETS } from "@/lib/views/dashboards/starter";
import {
  changeWidgets,
  createDashboard,
  type DashboardsDb,
  deleteDashboard,
  getDashboard,
  listDashboards,
  renameDashboard,
} from "@/lib/views/dashboards/store";
import { MAX_WIDGETS } from "@/lib/views/dashboards/types";
import {
  fitWidget,
  scorersOfMetric,
  scorerWidget,
  widgetName,
} from "@/lib/views/dashboards/widget";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const WIDGET = {
  title: "",
  metric: "latency",
  aggregation: "p95",
  groupBy: null,
  filter: { models: ["gpt-4o"] },
  chart: "line",
  width: "half",
} as const;

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
    (await listDashboards(PROJECT, db)).map((d) => [d.id, d.name, d.widgets]),
    [[id, "Speed", []]],
  );
  await ok({ action: "delete", dashboardId: id });
  assert.deepEqual(await listDashboards(PROJECT, db), []);
  await refused({ action: "delete", dashboardId: id }, /no longer exists/);
});

test("add, edit, reorder and remove a widget", async () => {
  const id = await created();
  for (const title of ["a", "b", "c"])
    await ok({ action: "add-widget", dashboardId: id, widget: { ...WIDGET, title } });
  const [a, b] = await widgets(id);
  assert.deepEqual(a, { ...WIDGET, title: "a", id: a.id });

  await ok({
    action: "edit-widget",
    dashboardId: id,
    widgetId: b.id,
    widget: { ...WIDGET, title: "B", width: "full" },
  });
  assert.deepEqual((await widgets(id))[1], { ...WIDGET, title: "B", width: "full", id: b.id });

  await ok({ action: "move-widget", dashboardId: id, widgetId: b.id, direction: "up" });
  assert.deepEqual(await titles(id), ["B", "a", "c"]);
  await ok({ action: "move-widget", dashboardId: id, widgetId: b.id, direction: "up" });
  assert.deepEqual(await titles(id), ["B", "a", "c"]);
  await ok({ action: "move-widget", dashboardId: id, widgetId: b.id, direction: "down" });
  assert.deepEqual(await titles(id), ["a", "B", "c"]);

  await ok({ action: "remove-widget", dashboardId: id, widgetId: b.id });
  assert.deepEqual(await titles(id), ["a", "c"]);
  // The undo of a removal puts it back where it was.
  await ok({
    action: "add-widget",
    dashboardId: id,
    index: 1,
    widget: { ...WIDGET, title: "B" },
  });
  assert.deepEqual(await titles(id), ["a", "B", "c"]);
  await refused(
    { action: "remove-widget", dashboardId: id, widgetId: b.id },
    /widget no longer exists/,
  );
});

test("the starter set is four valid widgets", async () => {
  const result = await run({ action: "create-starter" });
  assert.ok(result.ok);
  const stored = await widgets(result.dashboardId);
  assert.equal(stored.length, 4);
  assert.equal(new Set(stored.map((widget) => widget.id)).size, 4);
  for (const widget of STARTER_WIDGETS) assert.ok(parseWidget(widget).ok, widget.metric);
});

test("a widget that does not fit the metric catalog or its chart is refused", async () => {
  const id = await created();
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ metric: "nope" }, /Unknown metric/],
    [{ aggregation: "sum" }, /cannot be aggregated/],
    [{ chart: "table" }, /needs a group-by/],
    [{ chart: "number", groupBy: "model" }, /cannot be grouped/],
    [{ chart: "pie" }, /invalid/],
    [{ width: "huge" }, /invalid/],
    [{ groupBy: "customer" }, /invalid/],
    [{ filter: { sql: "1=1" } }, /invalid/],
    [{ filter: { models: "gpt-4o" } }, /invalid/],
    [{ title: "x".repeat(81) }, /invalid/],
    [{ metric: "context_cost", aggregation: "sum", filter: {}, groupBy: "model" }, /be grouped/],
    [{ metric: "context_cost", aggregation: "sum" }, /cannot be filtered/],
  ];
  for (const [change, error] of bad) {
    const widget = { ...WIDGET, ...change };
    await refused({ action: "add-widget", dashboardId: id, widget }, error);
  }
  await refused({ action: "add-widget", dashboardId: id }, /invalid/);
  assert.deepEqual(await widgets(id), []);
});

test("a scorer widget is accepted with the scorers switch only", async () => {
  const id = await created();
  const widget = scorerWidget({ id: OTHER, verdict: true });
  await refused({ action: "add-widget", dashboardId: id, widget }, /is off/);
  const on = { features: async () => ({ scorers: true }) };
  assert.ok((await run({ action: "add-widget", dashboardId: id, widget }, on)).ok);
  const [stored] = await widgets(id);
  assert.deepEqual(stored, { ...widget, id: stored.id });
  await refused({ action: "edit-widget", dashboardId: id, widgetId: stored.id, widget }, /is off/);
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ scorerId: "nope" }, /Unknown scorer/],
    [{ groupBy: "tool" }, /be grouped/],
    [{ metric: "trace_count", aggregation: "count" }, /filtered by scorer/],
  ];
  for (const [change, error] of bad) {
    const changed = { ...widget, ...change };
    await refused({ action: "add-widget", dashboardId: id, widget: changed }, error, on);
  }
});

test("leaving the scorer metrics drops the scorer; each metric offers the scorers it reads", () => {
  const widget = scorerWidget({ id: OTHER, verdict: false });
  assert.equal(widget.metric, "scorer_average");
  assert.equal(fitWidget({ ...widget, metric: "scorer_count" }).scorerId, OTHER);
  assert.equal(fitWidget({ ...widget, metric: "cost" }).scorerId, undefined);
  const scorers = [
    { id: "a", name: "A", verdict: true },
    { id: "b", name: "B", verdict: false },
  ];
  const ids = (metric: MetricId) => scorersOfMetric(metric, scorers).map(({ id }) => id);
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
  await refused(
    { action: "move-widget", dashboardId: id, widgetId: "x", direction: "left" },
    /invalid/,
  );
  assert.deepEqual(await changeDashboard(null, deps()), {
    ok: false,
    error: "The dashboard change is invalid.",
  });
});

test("a dashboard holds at most 24 widgets", async () => {
  const id = await created();
  for (let index = 0; index < MAX_WIDGETS; index += 1)
    await ok({ action: "add-widget", dashboardId: id, widget: WIDGET });
  await refused({ action: "add-widget", dashboardId: id, widget: WIDGET }, /24 widgets/);
});

test("fitWidget keeps the editor on a widget the rules allow", () => {
  const fit = (change: object) => fitWidget({ ...WIDGET, ...change });
  assert.equal(fit({ chart: "table" }).groupBy, "model");
  assert.equal(fit({ chart: "number", groupBy: "model" }).groupBy, null);
  assert.equal(fit({ metric: "cost" }).aggregation, "sum");
  const context = fit({ metric: "context_tokens", chart: "table", groupBy: "model" });
  assert.equal(context.chart, "line");
  for (const widget of [fit({ chart: "table" }), fit({ metric: "cost" }), context])
    assert.ok(parseWidget(widget).ok);
});

test("a widget is named after what it measures until it has a title", () => {
  assert.equal(widgetName(WIDGET), "Latency p95");
  assert.equal(widgetName({ ...WIDGET, groupBy: "model" }), "Latency p95 by model");
  assert.equal(widgetName({ ...WIDGET, metric: "cost", aggregation: "sum" }), "Cost");
  assert.equal(widgetName({ ...WIDGET, metric: "cost", aggregation: "avg" }), "Cost per trace");
  assert.equal(widgetName({ ...WIDGET, title: "Speed" }), "Speed");
});

function deps(overrides: Partial<DashboardActionDeps> = {}): DashboardActionDeps {
  return {
    getSession: async () => ({ user: { id: "user-1", externalId: "ext-1" } }),
    findProjectScope: async (projectId) => ({
      project: { id: projectId },
      organization: { id: ORG },
    }),
    enabled: async () => true,
    features: async () => ({ scorers: false }),
    isRestricted: async () => false,
    store: {
      listDashboards: (projectId) => listDashboards(projectId, db),
      createDashboard: (input) => createDashboard(input, db),
      renameDashboard: (input) => renameDashboard(input, db),
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
  return dashboard.widgets;
}

async function titles(id: string) {
  return (await widgets(id)).map((widget) => widget.title);
}
