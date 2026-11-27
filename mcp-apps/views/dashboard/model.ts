import type { QueryResult } from "@/lib/synthesis/metrics/query";
import type { DashboardRange } from "@/lib/views/dashboards/links";
import type { DashboardFilters, GridPosition, WidgetInput } from "@/lib/views/dashboards/types";
import type { ToolSuccess } from "../../shell/state";

/** What get_dashboard and query_monitoring carry for this view (lib/mcp/operations/monitoring). */
export interface DashboardModel {
  projectId: string;
  name: string;
  /** The console's page: the dashboard, or Explore with the same queries. */
  href?: string;
  range: DashboardRange;
  filters: DashboardFilters;
  widgets: ViewWidget[];
}

export interface ViewWidget {
  id: string;
  name: string;
  layout: GridPosition;
  /** Absent for a broken one. */
  widget?: WidgetInput;
  missingScorer?: string;
  /** Why it cannot be shown. */
  problem?: string;
  result: QueryResult | null;
}

/** The text form: what any host passes on. */
export interface DashboardText {
  name: string;
  href?: string;
  widgets: { id: string; name: string; summary: string }[];
}

export const VIEW_KIND = "dashboard";

/** The view's own model, or null where a host passed the text only. */
export function readDashboard(result: Pick<ToolSuccess, "view">): DashboardModel | null {
  const model = result.view;
  return model?.kind === VIEW_KIND && Array.isArray(model.widgets)
    ? (model as unknown as DashboardModel)
    : null;
}

/** The widgets in one line each, from the text every host gets. */
export function readText(data: unknown): DashboardText {
  const { dashboard, widgets, name, summary, href: explore } = record(data);
  if (Array.isArray(widgets)) {
    const { name: title, href } = record(dashboard);
    const page = text(href) || text(explore);
    return {
      name: text(title) || text(name) || "Dashboard",
      ...(page ? { href: page } : {}),
      widgets: widgets.map(record).map((widget, index) => ({
        id: text(widget.id) || String(index),
        name: text(widget.name),
        summary: text(widget.problem) || text(widget.summary) || "No numbers were read.",
      })),
    };
  }
  return {
    name: "Query",
    ...(text(explore) ? { href: text(explore) } : {}),
    widgets: [{ id: "query", name: text(name), summary: text(summary) }],
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
