import { notFound } from "next/navigation";
import { DashboardView } from "@/components/console/dashboards/DashboardView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { parseProjectUuid } from "@/lib/platform/projects/queries";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  EMPTY_TRACE_FILTER_FACETS,
  getTraceFilterFacets,
} from "@/lib/synthesis/traces/trace-filters";
import { resolveTraceRange, type TraceListSearchParams } from "@/lib/synthesis/traces/view";
import { loadWidgets } from "@/lib/views/dashboards/data";
import { getDashboard } from "@/lib/views/dashboards/store";
import { dashboardsScope } from "../context";

export const metadata = { title: "Dashboard" };

/** One dashboard over the time window in the URL. */
export default async function ScopedDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; dashboardId: string }>;
  searchParams: Promise<TraceListSearchParams>;
}) {
  const { projectId, dashboardId } = await params;
  const scope = await dashboardsScope(projectId);
  if (!scope)
    return (
      <DatabaseUnavailable title="Dashboard">
        Dashboards become available once setup finishes.
      </DatabaseUnavailable>
    );
  const id = parseProjectUuid(dashboardId);
  const dashboard = id ? await getDashboard(scope.project.id, id) : null;
  if (!dashboard) notFound();

  const now = new Date();
  const range = resolveTraceRange(await searchParams, now);
  const [results, facets] = await Promise.all([
    loadWidgets(scope.project.id, dashboard.widgets, range),
    loadOrFallback({
      operation: "dashboard_facets",
      distinctId: `project:${scope.project.id}`,
      fallback: EMPTY_TRACE_FILTER_FACETS,
      load: () =>
        withStatementTimeout(
          (db) => getTraceFilterFacets(scope.project.id, range, db, undefined, { entities: true }),
          { operation: "dashboard_facets", timeoutMs: supplementaryReadTimeoutMs() },
        ),
    }),
  ]);
  return (
    <DashboardView
      projectId={scope.project.id}
      dashboard={{ id: dashboard.id, name: dashboard.name }}
      widgets={dashboard.widgets.map((widget, index) => ({ widget, result: results[index] }))}
      facets={facets}
      timeWindow={{
        preset: range.preset,
        from: range.from,
        to: range.to,
        today: now.toISOString().slice(0, 10),
      }}
    />
  );
}
