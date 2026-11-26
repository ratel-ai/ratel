import { featureEnabled } from "@/lib/platform/experimental-features";
import type { RangePreset } from "@/lib/synthesis/dashboard";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import { loadWidget, loadWidgets } from "@/lib/views/dashboards/data";
import { dashboardHref } from "@/lib/views/dashboards/links";
import { getDashboards } from "@/lib/views/dashboards/store";
import { isBroken } from "@/lib/views/dashboards/stored-widget";
import type {
  Dashboard,
  DashboardFilters,
  Widget,
  WidgetResult,
} from "@/lib/views/dashboards/types";
import { widgetName } from "@/lib/views/dashboards/widget";
import type { OverviewReadScope } from "@/lib/views/home/overview-reads";
import {
  type DashboardItemId,
  parseDashboardItem,
} from "@/lib/views/overview-layout/domain/layout";

/** A dashboard widget on the Overview, as its dashboard has it now. */
export type DashboardItem =
  | {
      kind: "widget";
      title: string;
      dashboard: { name: string; href: string };
      widget: Widget;
      /** Null when the read failed. */
      result: WidgetResult | null;
      /** The dashboard's saved ones. */
      filters: DashboardFilters;
      range: DashboardItemsRange;
    }
  /** There is nothing to draw: its source is gone, or the reference or the widget cannot be read. */
  | { kind: "broken"; title: string | null; problem: string };

export type DashboardItems = Readonly<Partial<Record<DashboardItemId, DashboardItem>>>;

export interface DashboardItemsRange {
  preset: RangePreset;
  from: string;
  to: string;
}

type Found = { id: DashboardItemId; dashboard: Dashboard; widget: Widget };

/** What the items read, in a test another database or flag. */
export interface DashboardItemReads {
  dashboards: typeof getDashboards;
  widget: typeof loadWidget;
  /** The `rql` flag: the numbers of a widget of kind sql. */
  rqlEnabled(at: Pick<OverviewReadScope, "projectId" | "organization">): Promise<boolean>;
}

const DASHBOARD_ITEM_READS: DashboardItemReads = {
  dashboards: getDashboards,
  widget: loadWidget,
  rqlEnabled: ({ projectId, organization }) =>
    featureEnabled("rql", { projectId, organizationId: organization.id }),
};

/** The numbers are the dashboard's own for the Overview's window, under its saved filters. */
export async function readDashboardItems(
  at: OverviewReadScope,
  ids: readonly DashboardItemId[],
  range: DashboardItemsRange,
  reads: DashboardItemReads = DASHBOARD_ITEM_READS,
): Promise<DashboardItems> {
  const refs = ids.map((id) => ({ id, ref: parseDashboardItem(id) }));
  const wanted = [...new Set(refs.flatMap(({ ref }) => ref?.dashboardId ?? []))];
  const dashboards = new Map(
    (await reads.dashboards(at.projectId, wanted, at.db)).map((one) => [one.id, one]),
  );
  const items: Partial<Record<DashboardItemId, DashboardItem>> = {};
  const found: Found[] = [];
  for (const { id, ref } of refs) {
    const dashboard = ref ? dashboards.get(ref.dashboardId.toLowerCase()) : undefined;
    const widget = dashboard?.widgets.find((one) => one.id === ref?.widgetId);
    if (!ref) items[id] = broken("This reference to a dashboard widget cannot be read.");
    else if (!dashboard) items[id] = broken("Its dashboard was deleted.");
    else if (!widget) items[id] = broken(`It was removed from the dashboard ${dashboard.name}.`);
    else if (isBroken(widget)) items[id] = broken(widget.problem, widget.title);
    else found.push({ id, dashboard, widget });
  }
  const filterOf = new Map(found.map(({ widget, dashboard }) => [widget, dashboard.filters]));
  // One pool for every dashboard, so that they cannot take the connections together.
  const results = await loadWidgets(
    at.projectId,
    found.map(({ widget }) => widget),
    at.current,
    // They are on the Overview only with customMonitoring; an RQL widget reads with `rql` on only.
    { customMonitoring: true, rql: await reads.rqlEnabled(at) },
    (projectId, widget, scope: QueryScope) =>
      reads.widget(projectId, widget, { ...scope, filter: filterOf.get(widget as Widget) }, at.db),
  );
  for (const [index, { id, dashboard, widget }] of found.entries())
    items[id] = {
      kind: "widget",
      title: widgetName(widget),
      dashboard: { name: dashboard.name, href: dashboardHref(at.projectId, dashboard.id) },
      widget,
      result: results[index],
      filters: dashboard.filters,
      range,
    };
  return items;
}

function broken(problem: string, title: string | null = null): DashboardItem {
  return { kind: "broken", title, problem };
}
