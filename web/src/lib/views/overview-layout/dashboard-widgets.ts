import { getDb } from "@/lib/platform/db/client";
import { type DashboardsDb, getDashboard, getDashboards } from "@/lib/views/dashboards/store";
import { isWidget } from "@/lib/views/dashboards/stored-widget";
import type { Widget } from "@/lib/views/dashboards/types";
import { widgetName } from "@/lib/views/dashboards/widget";
import type { DashboardItemRef, DashboardItemSource } from "./domain/layout";

/** A widget of a dashboard of this project, as the Overview takes it. One that is broken is none. */
export async function findDashboardWidget(
  projectId: string,
  { dashboardId, widgetId }: DashboardItemRef,
  db: DashboardsDb = getDb(),
): Promise<DashboardItemSource | null> {
  const dashboard = await getDashboard(projectId, dashboardId, db);
  const widget = dashboard?.widgets.filter(isWidget).find(({ id }) => id === widgetId);
  return widget ? sourceOf(widget) : null;
}

export interface OfferedDashboard {
  id: string;
  name: string;
  widgets: (DashboardItemSource & { id: string })[];
}

/** Every widget that can be added, by dashboard. */
export async function offeredDashboardWidgets(
  projectId: string,
  db: DashboardsDb = getDb(),
): Promise<OfferedDashboard[]> {
  const dashboards = await getDashboards(projectId, undefined, db);
  return dashboards
    .map(({ id, name, widgets }) => ({
      id,
      name,
      widgets: widgets.filter(isWidget).map((widget) => ({ id: widget.id, ...sourceOf(widget) })),
    }))
    .filter(({ widgets }) => widgets.length > 0);
}

function sourceOf(widget: Widget): DashboardItemSource {
  return { title: widgetName(widget), w: widget.layout.w, h: widget.layout.h };
}
