import { ExploreView } from "@/components/console/explore/ExploreView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import type { TimeWindow } from "@/components/console/traces/TracesHeader";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { searchFromParams } from "@/lib/synthesis/traces/v2/filters";
import type { TraceListSearchParams } from "@/lib/synthesis/traces/view";
import { loadWidgets } from "@/lib/views/dashboards/data";
import { filtersProblem, shownFilters } from "@/lib/views/dashboards/filters";
import { EXACT_RANGE, wholeDays } from "@/lib/views/dashboards/links";
import { parseWidget } from "@/lib/views/dashboards/parse-widget";
import { rangeProblem, resolveWidgetRange } from "@/lib/views/dashboards/range";
import { listDashboards } from "@/lib/views/dashboards/store";
import { panelsOfAddress } from "@/lib/views/explore/state";
import { metricFeatures } from "../dashboards/context";
import { loadWidgetForm } from "../dashboards/form-data";
import { resolveExplorePage } from "./context";

export const dynamic = "force-dynamic";
export const metadata = { title: "Explore" };

/** One to four panels over the filters and the time window in the URL. Nothing is stored. */
export default async function ScopedExplorePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<TraceListSearchParams>;
}) {
  const page = await resolveExplorePage((await params).projectId);
  if (!page)
    return (
      <DatabaseUnavailable title="Explore">
        Explore becomes available once setup finishes.
      </DatabaseUnavailable>
    );
  const { projectId } = page;
  const now = new Date();
  const search = await searchParams;
  const range = resolveWidgetRange(search, now);
  const days = wholeDays(range);
  const address = searchFromParams(search);
  const filters = shownFilters(address, {});
  // Null: the panels are in the fragment, which only the browser has.
  const decoded = panelsOfAddress(address, null);
  const badRange = rangeProblem(search);
  const problem =
    badRange ??
    (decoded && !decoded.ok
      ? decoded.error
      : filtersProblem(decoded?.panels.map(({ query }) => query) ?? [], filters));
  const panels = decoded?.ok && !problem ? decoded.panels : [];
  const features = await metricFeatures(page);
  const [results, { facets, scorers }, dashboards] = await Promise.all([
    loadWidgets(projectId, panels, { ...range, filter: filters }, features),
    loadWidgetForm(projectId, range, features),
    loadOrFallback({
      operation: "explore_dashboards",
      distinctId: `project:${projectId}`,
      fallback: [],
      load: () => listDashboards(projectId),
    }),
  ]);
  return (
    <ExploreView
      projectId={projectId}
      served={panels.map((widget, index) => ({
        widget,
        // One that is not complete has not been read.
        result: parseWidget(widget, features).ok ? results[index] : undefined,
      }))}
      problem={problem}
      filters={filters}
      facets={facets}
      scorers={scorers}
      dashboards={dashboards.map(({ id, name }) => ({ id, name }))}
      range={{ preset: range.preset, from: range.from, to: range.to }}
      timeWindow={{
        preset: range.preset === EXACT_RANGE ? "custom" : (range.preset as TimeWindow["preset"]),
        ...days,
        today: now.toISOString().slice(0, 10),
      }}
    />
  );
}
