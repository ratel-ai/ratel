import type { TraceFilter } from "@/lib/synthesis/traces/trace-filters";
import { traceFilterFromSearch } from "@/lib/synthesis/traces/v2/filters";
import { dashboardFiltersSchema, withBarSearch } from "@/lib/views/dashboards/filters";
import {
  type DashboardRange,
  EXACT_RANGE,
  searchFromTraceFilter,
} from "@/lib/views/dashboards/links";
import type { WidgetInput } from "@/lib/views/dashboards/types";
import { startPanel } from "@/lib/views/explore/starts";
import { withPanels } from "@/lib/views/explore/state";
import type { ExploreView } from "@/lib/views/explore/types";

/** The Explore page's addresses. */

/** The page with that view, or with the start panel. */
export function exploreHref(projectId: string, view?: ExploreView): string {
  const path = `/project/${encodeURIComponent(projectId)}/explore`;
  if (!view) return path;
  const { panels, filters, range } = view;
  const params = new URLSearchParams(withBarSearch("", searchFromTraceFilter(filters), {}));
  if (range) {
    params.set("range", range.preset);
    if (range.preset === "custom" || range.preset === EXACT_RANGE) {
      params.set("from", range.from);
      params.set("to", range.to);
    }
  }
  return `${path}${withPanels(params.toString(), panels)}`;
}

/** The page with one widget. */
export function explorePanelHref(
  projectId: string,
  widget: WidgetInput,
  view: Omit<ExploreView, "panels">,
): string {
  return explorePanelsHref(projectId, [widget], view);
}

/** The page with those widgets. */
export function explorePanelsHref(
  projectId: string,
  widgets: readonly WidgetInput[],
  view: Omit<ExploreView, "panels">,
): string {
  // A stored widget has more than a panel: its id and its place.
  const panels = widgets.map(({ title, query, chart }) => ({ title, query, chart }));
  return exploreHref(projectId, { panels, ...view });
}

/**
 * The page with the filters and the time range of a Traces list. The page's bar takes the filters
 * it has; the others become the panel's own. Filters too long for the bar are the panel's too.
 */
export function exploreTracesHref(
  projectId: string,
  search: string,
  range: DashboardRange | null,
): string {
  const all: TraceFilter = traceFilterFromSearch(search, { entities: true });
  const { environments, services, models, agents, ...own } = all;
  const bar = Object.fromEntries(
    Object.entries({ environments, services, models, agents }).filter(([, values]) => values),
  );
  const inBar = dashboardFiltersSchema.safeParse(bar).success;
  const panel = startPanel((inBar ? own : all) as Parameters<typeof startPanel>[0]);
  return explorePanelHref(projectId, panel, { filters: inBar ? bar : {}, range });
}
