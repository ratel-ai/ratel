import { notFound, permanentRedirect } from "next/navigation";
import { DashboardView } from "@/components/console/dashboards/DashboardView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { focusedConsoleEnabled } from "@/lib/console/focused-console";
import { projectRoot } from "@/lib/console/navigation";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { parseProjectUuid } from "@/lib/platform/projects/queries";
import { searchFromParams } from "@/lib/synthesis/traces/v2/filters";
import { resolveTraceRange, type TraceListSearchParams } from "@/lib/synthesis/traces/view";
import { loadWidgets } from "@/lib/views/dashboards/data";
import { filtersProblem, shownFilters } from "@/lib/views/dashboards/filters";
import { ADD_SCORER_PARAM } from "@/lib/views/dashboards/links";
import { getDashboard } from "@/lib/views/dashboards/store";
import { isWidget } from "@/lib/views/dashboards/stored-widget";
import { scorerWidget } from "@/lib/views/dashboards/widget";
import { dashboardsEnabled, dashboardsScope, metricFeatures } from "../context";
import { loadWidgetForm } from "../form-data";

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
  // The saved range, unless the address has one.
  const ownRange = search.range || search.from || search.to;
  const range = resolveTraceRange(
    ownRange ? search : { ...search, range: dashboard.range ?? undefined },
    now,
  );
  const filters = shownFilters(searchFromParams(search), dashboard.filters);
  const problem = filtersProblem(
    dashboard.widgets.filter(isWidget).map(({ query }) => query),
    filters,
  );
  const features = await metricFeatures({
    projectId: scope.project.id,
    organizationId: scope.organization.id,
    actor: scope.user.externalId,
  });
  const [results, { facets, scorers }, alerts] = await Promise.all([
    loadWidgets(
      scope.project.id,
      problem ? [] : dashboard.widgets,
      { ...range, filter: filters },
      features,
    ),
    loadWidgetForm(scope.project.id, range, features),
    featureEnabled("customMonitoring", {
      projectId: scope.project.id,
      organizationId: scope.organization.id,
      actor: scope.user.externalId,
    }),
  ]);
  const overview = await focusedConsoleEnabled(scope.organization);
  const added = scorers?.find(({ id }) => id === search[ADD_SCORER_PARAM]);
  return (
    <DashboardView
      scorers={scorers}
      alerts={alerts}
      overview={overview}
      draft={added ? scorerWidget(added) : null}
      projectId={scope.project.id}
      dashboard={{
        id: dashboard.id,
        name: dashboard.name,
        defaults: { filters: dashboard.filters, range: dashboard.range },
      }}
      filters={filters}
      problem={problem}
      widgets={dashboard.widgets.map((widget, index) => ({
        widget,
        result: results[index] ?? null,
      }))}
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
