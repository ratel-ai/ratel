import { notFound } from "next/navigation";
import { DashboardView } from "@/components/console/dashboards/DashboardView";
import { TaskNamesProvider } from "@/components/console/dashboards/TaskNamesProvider";
import { PropertyChoicesProvider } from "@/components/console/properties/PropertyChoicesProvider";
import { ScorerPickerProvider } from "@/components/console/scorers/ScorerPickerProvider";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { focusedConsoleEnabled } from "@/lib/console/focused-console";
import { parseProjectUuid } from "@/lib/platform/projects/queries";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { searchFromParams } from "@/lib/synthesis/traces/v2/filters";
import { resolveTraceRange, type TraceListSearchParams } from "@/lib/synthesis/traces/view";
import { askConfigured } from "@/lib/views/ask/model";
import { BUILT_BY_ASK_PARAM } from "@/lib/views/ask/outcome";
import { askLeftOut } from "@/lib/views/ask/store";
import { loadWidgets } from "@/lib/views/dashboards/data";
import { filtersProblem, shownFilters } from "@/lib/views/dashboards/filters";
import { ADD_SCORER_PARAM } from "@/lib/views/dashboards/links";
import { getDashboard } from "@/lib/views/dashboards/store";
import { isWidget } from "@/lib/views/dashboards/stored-widget";
import { scorerWidget } from "@/lib/views/dashboards/widget";
import { dashboardsScope } from "../context";
import { loadWidgetForm } from "../form-data";

export const metadata = { title: "Dashboard" };

/** One dashboard over the time window in the URL. */
export default async function ScopedDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; dashboardId: string }>;
  searchParams: Promise<
    TraceListSearchParams & {
      [ADD_SCORER_PARAM]?: string | string[];
      [BUILT_BY_ASK_PARAM]?: string | string[];
    }
  >;
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
  const [results, { facets, scorers, properties, usage, taskNames }, readOnly] = await Promise.all([
    loadWidgets(scope.project.id, problem ? [] : dashboard.widgets, { ...range, filter: filters }),
    loadWidgetForm(scope.project.id, range),
    isRestrictedBySupportSession(),
  ]);
  const overview = await focusedConsoleEnabled(scope.organization);
  // A dashboard an ask built names the widgets the ask left out.
  const builtBy = parseProjectUuid(String(search[BUILT_BY_ASK_PARAM] ?? ""));
  const leftOut = builtBy ? await askLeftOut(scope.project.id, builtBy) : null;
  const added = scorers?.scorers.find(({ id }) => id === search[ADD_SCORER_PARAM]);
  return (
    <ScorerPickerProvider projectId={scope.project.id} data={scorers}>
      <PropertyChoicesProvider projectId={scope.project.id} choices={properties} usage={usage}>
        <TaskNamesProvider names={taskNames}>
          <DashboardView
            overview={overview}
            readOnly={readOnly}
            ask={askConfigured()}
            leftOut={leftOut ?? []}
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
        </TaskNamesProvider>
      </PropertyChoicesProvider>
    </ScorerPickerProvider>
  );
}
