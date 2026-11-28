import { loadStoredPropertyNames } from "@/lib/ingest/properties/store";
import { getDb } from "@/lib/platform/db/client";
import { type DashboardsDb, getDashboards } from "@/lib/views/dashboards/store";
import type { DashboardWidget } from "@/lib/views/dashboards/types";
import type { AskContext, AskContextWidget, AskTarget } from "./domain";
import { ASK_EARLIER_ASKS, ASK_OTHER_WIDGETS } from "./limits";
import { listEarlierAsks } from "./store";

/**
 * The context of one ask, read for its project only: the names of the indexed properties, the
 * titles and RQL of the dashboard's widgets (for a new dashboard, of the other dashboards, capped),
 * and the earlier asks. No trace row and no property value is read.
 */
export async function loadAskContext(
  projectId: string,
  target: AskTarget,
  dashboardId: string | null,
  db: DashboardsDb & Pick<ReturnType<typeof getDb>, "execute"> = getDb(),
): Promise<AskContext> {
  const [properties, dashboards, earlierAsks] = await Promise.all([
    loadStoredPropertyNames(projectId, db),
    getDashboards(projectId, undefined, db),
    listEarlierAsks(projectId, ASK_EARLIER_ASKS, db),
  ]);
  const own = dashboardId ? dashboards.find(({ id }) => id === dashboardId) : undefined;
  const others =
    target === "dashboard"
      ? dashboards
          .filter(({ id }) => id !== dashboardId)
          .flatMap(({ name, widgets }) =>
            widgets.flatMap(rqlOf).map((widget) => ({ ...widget, dashboard: name })),
          )
          .slice(0, ASK_OTHER_WIDGETS)
      : [];
  return {
    properties: properties.indexed,
    widgets: own ? own.widgets.flatMap(rqlOf) : [],
    otherWidgets: others,
    earlierAsks,
  };
}

/** A widget of kind sql as its title and its text; any other widget is left out. */
function rqlOf(widget: DashboardWidget): AskContextWidget[] {
  if (!("query" in widget) || widget.query.kind !== "sql") return [];
  return [{ title: widget.title, rql: widget.query.text }];
}
