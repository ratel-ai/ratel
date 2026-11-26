import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import { metricQuery } from "@/lib/contracts/query";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { resolveTraceRange } from "@/lib/synthesis/traces/view";
import { loadWidget, loadWidgets } from "@/lib/views/dashboards/data";
import {
  changeWidgets,
  createDashboard,
  deleteDashboard,
  getDashboard,
} from "@/lib/views/dashboards/store";
import { isWidget } from "@/lib/views/dashboards/stored-widget";
import type { Widget } from "@/lib/views/dashboards/types";
import { FOCUSED_READS, loadFocusedOverview } from "@/lib/views/home/focused-load";
import {
  findDashboardWidget,
  offeredDashboardWidgets,
} from "@/lib/views/overview-layout/dashboard-widgets";
import {
  changeLayout,
  dashboardItemId,
  type OverviewLayout,
  UNFLAGGED_LAYOUT,
} from "@/lib/views/overview-layout/domain/layout";

/** A dashboard widget on the Overview shows what its dashboard shows, as it is now. */

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-24T10:00:00Z");
const EDITOR = { updatedBy: "ana", updatedByName: "Ana" };
const BY_MODEL: Widget = {
  id: "models",
  title: "Runs by model",
  query: metricQuery("trace_count", "count", { dimensions: ["model"] }),
  chart: "table",
  layout: { x: 0, y: 0, w: 6, h: 5 },
};

let client: Awaited<ReturnType<typeof createMigratedPGlite>>;
let db: ReturnType<typeof getDb>;

before(async () => {
  client = await createMigratedPGlite();
  db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;
  await client.exec(`
    insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug) values
      ('${PROJECT}', '${ORG}', 'Agent', 'agent'), ('${OTHER}', '${ORG}', 'Other', 'other');
  `);
  for (const [n, model, environment, daysAgo] of [
    [1, "gpt-4o", "web", 1],
    [2, "gpt-4o", "web", 2],
    [3, "claude-sonnet-4-6", "web", 3],
    [4, "gpt-4o", "batch", 1],
    [5, "gpt-4o", "web", 20],
  ] as const)
    await client.query(
      `insert into otel_trace_summaries (project_id, trace_id, started_at, duration_ms, has_error,
         input_tokens, output_tokens, cost_usd, models, environment, spans_max_received_at, updated_at)
       values ($1, $2, $3, 100, false, 1, 1, 0, $4, $5, $3, $3)`,
      [
        PROJECT,
        String(n).padStart(32, "0"),
        new Date(NOW.getTime() - daysAgo * 86_400_000),
        [model],
        environment,
      ],
    );
});
beforeEach(() => client.exec("delete from dashboards"));
after(() => client.close());

const board = async (projectId = PROJECT) => {
  const made = await createDashboard(
    {
      projectId,
      name: "Board",
      widgets: [BY_MODEL],
      filters: { environments: ["web"] },
      ...EDITOR,
    },
    db,
  );
  assert.ok(made);
  return made;
};

async function overview(layout: OverviewLayout, window: 7 | 30 = 7) {
  const { dashboards } = await loadFocusedOverview({
    project: { id: PROJECT, name: "Agent", slug: "agent", isDemo: false },
    organization: { id: ORG } as Parameters<typeof loadFocusedOverview>[0]["organization"],
    window,
    now: NOW,
    layout,
    db,
    reads: FOCUSED_READS,
  });
  return dashboards;
}

/** Only the item: the others would read the pool. */
function withItem(id: ReturnType<typeof dashboardItemId>): OverviewLayout {
  const without = UNFLAGGED_LAYOUT.map((widget) => ({ ...widget, removed: true }));
  return changeLayout(without, {
    kind: "add",
    widget: id,
    source: { title: "Runs by model", w: 6, h: 5 },
  });
}

test("the same rows as on the dashboard, for the same range and filters", async () => {
  const { id } = await board();
  const entry = dashboardItemId(id, "models");
  for (const window of [7, 30] as const) {
    const items = await overview(withItem(entry), window);
    assert.ok(items && items !== "failed");
    const item = items[entry];
    assert.ok(item?.kind === "widget");
    const dashboard = await getDashboard(PROJECT, id, db);
    assert.ok(dashboard);
    const range = resolveTraceRange({ range: `${window}d` }, NOW);
    const [result] = await loadWidgets(
      PROJECT,
      dashboard.widgets,
      { ...range, filter: dashboard.filters },
      { customMonitoring: true },
      (project, widget, at) => loadWidget(project, widget, at, db),
    );
    assert.deepEqual(item.result, result);
    assert.ok(result?.kind === "metric");
    assert.deepEqual(
      result.series.map(({ groups, total }) => [groups[0].value, total]),
      [
        ["gpt-4o", window === 7 ? 2 : 3],
        ["claude-sonnet-4-6", 1],
      ],
    );
    assert.deepEqual(item.filters, { environments: ["web"] });
    assert.deepEqual(item.range, { preset: `${window}d`, from: range.from, to: range.to });
    assert.equal(item.dashboard.name, "Board");
    assert.equal(item.dashboard.href, `/project/${PROJECT}/dashboards/${id}`);
  }
});

test("it follows an edit of the source widget", async () => {
  const { id } = await board();
  const entry = dashboardItemId(id, "models");
  await changeWidgets(
    {
      projectId: PROJECT,
      id,
      change: (widgets) =>
        widgets.filter(isWidget).map((widget) => ({
          ...widget,
          title: "Runs",
          chart: "number",
          query: metricQuery("trace_count", "count"),
        })),
      ...EDITOR,
    },
    db,
  );
  const items = await overview(withItem(entry));
  const item = items && items !== "failed" && items[entry];
  assert.ok(item && item.kind === "widget");
  assert.equal(item.title, "Runs");
  assert.equal(item.widget.chart, "number");
  assert.ok(item.result?.kind === "metric");
  assert.equal(item.result.series[0].total, 3);
});

test("a source that is gone, another project's, or a reference that cannot be read is broken", async () => {
  const { id } = await board();
  const other = await board(OTHER);
  const problemOf = async (entry: ReturnType<typeof dashboardItemId>) => {
    const items = await overview(withItem(entry));
    const item = items && items !== "failed" && items[entry];
    assert.ok(item && item.kind === "broken");
    return item.problem;
  };
  const gone = "It was removed from the dashboard Board.";
  assert.equal(await problemOf(dashboardItemId(id, "no-such")), gone);
  assert.equal(await problemOf(dashboardItemId(other.id, "models")), "Its dashboard was deleted.");
  assert.match(await problemOf("dashboard:not-a-reference"), /cannot be read/);
  await client.query("update dashboards set widgets = $1 where id = $2", [
    JSON.stringify([{ ...BY_MODEL, query: { kind: "nothing" } }]),
    id,
  ]);
  assert.ok(await problemOf(dashboardItemId(id, "models")));
  await deleteDashboard(PROJECT, id, db);
  assert.equal(await problemOf(dashboardItemId(id, "models")), "Its dashboard was deleted.");
});

test("nothing is read without an entry, and a failed read is not an empty one", async () => {
  assert.equal(
    await overview(UNFLAGGED_LAYOUT.map((widget) => ({ ...widget, removed: true }))),
    null,
  );
  const failed = await loadFocusedOverview({
    project: { id: PROJECT, name: "Agent", slug: "agent", isDemo: false },
    organization: { id: ORG } as Parameters<typeof loadFocusedOverview>[0]["organization"],
    window: 7,
    now: NOW,
    layout: withItem(dashboardItemId(OTHER, "models")),
    db,
    reads: {
      ...FOCUSED_READS,
      dashboards: async () => {
        throw new Error("statement timeout");
      },
    },
  });
  assert.equal(failed.dashboards, "failed");
});

test("the picker offers the project's own widgets, by dashboard", async () => {
  const { id } = await board();
  await board(OTHER);
  const source = { title: "Runs by model", w: 6, h: 5 };
  assert.deepEqual(await offeredDashboardWidgets(PROJECT, db), [
    { id, name: "Board", widgets: [{ id: "models", ...source }] },
  ]);
  const ref = { dashboardId: id, widgetId: "models" };
  assert.deepEqual(await findDashboardWidget(PROJECT, ref, db), source);
  assert.equal(await findDashboardWidget(OTHER, ref, db), null);
});
