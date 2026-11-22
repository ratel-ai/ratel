import { z } from "zod";
import { projectRoot } from "@/lib/console/navigation";
import type { Pivot } from "@/lib/ingest/pivots/model";
import { listPivots } from "@/lib/ingest/pivots/store";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { notFound } from "@/lib/mcp/errors";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { round } from "@/lib/mcp/serialize";
import { getDb } from "@/lib/platform/db/client";
import {
  canOpenDashboard,
  type Dashboard,
  type DashboardWidget,
} from "@/lib/views/custom-dashboards/model";
import { widgetTitle } from "@/lib/views/custom-dashboards/present";
import type { WidgetResult } from "@/lib/views/custom-dashboards/query";
import { parseWidgetSpec } from "@/lib/views/custom-dashboards/spec";
import {
  findDashboard,
  listOpenDashboards,
  listWidgets,
} from "@/lib/views/custom-dashboards/store";
import { loadWidgetData, type WidgetData } from "@/lib/views/custom-dashboards/widget-data";

/**
 * Custom dashboards over MCP (RC-889): `list_dashboards` and `get_dashboard`.
 * They read with the rule of the pages (`canOpenDashboard`): a person over
 * OAuth reads their own dashboards and those shared with the project. A
 * project API key has no person, so it reads only the shared ones.
 */

export type DashboardPivot = Pick<Pivot, "key" | "label" | "presetId">;

export interface DashboardsOperationDeps {
  /** The dashboards the viewer opens; null viewer: the shared ones only. */
  listDashboards: (projectId: string, viewer: string | null) => Promise<Dashboard[]>;
  findDashboard: (projectId: string, dashboardId: string) => Promise<Dashboard | null>;
  listWidgets: (dashboardId: string) => Promise<DashboardWidget[]>;
  listPivots: (projectId: string) => Promise<DashboardPivot[]>;
  /** Every widget's rows, each under the read timeout; one failed widget reads `failed`. */
  loadWidgetData: (
    projectId: string,
    widgets: readonly DashboardWidget[],
    pivots: readonly DashboardPivot[],
  ) => Promise<WidgetData[]>;
}

export const defaultDashboardsDeps: DashboardsOperationDeps = {
  listDashboards: (projectId, viewer) => listOpenDashboards(projectId, viewer, getDb()),
  findDashboard: (projectId, dashboardId) => findDashboard(projectId, dashboardId, getDb()),
  listWidgets: (dashboardId) => listWidgets(dashboardId, getDb()),
  listPivots: (projectId) => listPivots(projectId, getDb()),
  loadWidgetData: (projectId, widgets, pivots) => loadWidgetData(projectId, widgets, { pivots }),
};

export function dashboardsOperations(
  deps: DashboardsOperationDeps = defaultDashboardsDeps,
): McpOperation[] {
  return [
    defineOperation({
      id: "list_dashboards",
      domain: "observability",
      title: "List dashboards",
      description:
        "The custom dashboards of this project, newest first. Each row has the id, the name, who sees it (private or project) and the page link. A project API key sees only the dashboards shared with the project. Call get_dashboard for the widgets and their data.",
      keywords: ["custom dashboards", "saved dashboards", "shared dashboards", "dashboard widgets"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        const dashboards = await deps.listDashboards(ctx.projectId, viewerOf(ctx.auth));
        return {
          data: { dashboards: dashboards.map(dashboardView) },
          ...(dashboards.length === 0
            ? {
                hint: "This caller sees no dashboard. A project API key sees only the dashboards shared with the project.",
              }
            : {}),
        };
      },
    }),
    defineOperation({
      id: "get_dashboard",
      domain: "observability",
      title: "Get a dashboard",
      description:
        "One custom dashboard from list_dashboards: its widgets in order, the spec of each widget (metric, group-by, chart, range, filter) and its current data. A grouped widget keeps its top groups and merges the rest into other. A project API key reads only a dashboard shared with the project.",
      keywords: ["dashboard data", "dashboard widgets", "widget rows", "custom dashboard"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        dashboardId: z
          .string()
          .min(1)
          .max(64)
          .describe("The dashboard id, as list_dashboards returns it."),
      }),
      async execute(ctx, params) {
        const dashboard = await deps.findDashboard(ctx.projectId, params.dashboardId);
        // A dashboard the caller may not open reads as not found, as on the page.
        if (!dashboard || !canOpenDashboard(dashboard, viewerOf(ctx.auth)))
          throw notFound("dashboard");
        const [widgets, pivots] = await Promise.all([
          deps.listWidgets(dashboard.id),
          deps.listPivots(ctx.projectId),
        ]);
        const data = await deps.loadWidgetData(ctx.projectId, widgets, pivots);
        return {
          data: {
            ...dashboardView(dashboard),
            widgets: widgets.map((widget, index) => widgetView(widget, data[index], pivots)),
          },
        };
      },
    }),
  ];
}

/** The person who reads, as `canOpenDashboard` takes it: null for a project API key. */
function viewerOf(auth: McpAuthContext): string | null {
  return auth.kind === "oauth" ? auth.externalUserId : null;
}

function dashboardView(dashboard: Dashboard) {
  return {
    id: dashboard.id,
    name: dashboard.name,
    sharing: dashboard.sharing,
    createdAt: dashboard.createdAt.toISOString(),
    updatedAt: dashboard.updatedAt.toISOString(),
    href: `${projectRoot(dashboard.projectId)}/dashboards/${encodeURIComponent(dashboard.id)}`,
  };
}

/** A widget: its spec (null when the stored spec no longer passes the whitelist) and its rows. */
function widgetView(
  widget: DashboardWidget,
  data: WidgetData | undefined,
  pivots: readonly DashboardPivot[],
) {
  const parsed = parseWidgetSpec(widget.spec);
  return {
    id: widget.id,
    title: parsed.ok ? widgetTitle(parsed.spec.metric, parsed.spec.groupBy, pivots) : null,
    spec: parsed.ok ? parsed.spec : null,
    result: !data || "failed" in data ? { kind: "failed" as const } : roundedResult(data.result),
  };
}

function roundedResult(result: WidgetResult): WidgetResult {
  if (result.kind === "total") return { ...result, value: round(result.value) };
  if (result.kind !== "groups") return result;
  return {
    ...result,
    groups: result.groups.map((group) => ({ ...group, value: round(group.value) })),
    other: result.other ? { ...result.other, value: round(result.other.value) } : null,
  };
}
