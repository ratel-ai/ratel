import { notFound, permanentRedirect } from "next/navigation";
import { DashboardView } from "@/components/console/dashboards/DashboardView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { projectRoot } from "@/lib/console/navigation";
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
import { ADD_SCORER_PARAM } from "@/lib/views/dashboards/links";
import { getDashboard } from "@/lib/views/dashboards/store";
import { scorerWidget } from "@/lib/views/dashboards/widget";
import { hasVerdict } from "@/lib/views/scorers/format";
import { listScorers } from "@/lib/views/scorers/store";
import { dashboardsEnabled, dashboardsScope, metricFeatures } from "../context";

export const metadata = { title: "Dashboard" };

/** One dashboard over the time window in the URL. */
export default async function ScopedDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; dashboardId: string }>;
  searchParams: Promise<TraceListSearchParams & { [ADD_SCORER_PARAM]?: string | string[] }>;
}) {
  const { projectId, dashboardId } = await params;
  if (!(await dashboardsEnabled(projectId)))
    permanentRedirect(`${projectRoot(projectId)}?peek=context`);
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
  const search = await searchParams;
  const range = resolveTraceRange(search, now);
  const features = await metricFeatures({
    projectId: scope.project.id,
    organizationId: scope.organization.id,
    actor: scope.user.externalId,
  });
  const [results, facets, scorers] = await Promise.all([
    loadWidgets(scope.project.id, dashboard.widgets, range, features),
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
    features.scorers
      ? loadOrFallback({
          operation: "dashboard_scorers",
          distinctId: `project:${scope.project.id}`,
          fallback: [],
          load: () => listScorers(scope.project.id),
        })
      : null,
  ]);
  const options = scorers?.map((scorer) => ({
    id: scorer.id,
    name: scorer.name,
    verdict: hasVerdict(scorer),
  }));
  const added = options?.find(({ id }) => id === search[ADD_SCORER_PARAM]);
  return (
    <DashboardView
      scorers={options ?? null}
      draft={added ? scorerWidget(added) : null}
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
