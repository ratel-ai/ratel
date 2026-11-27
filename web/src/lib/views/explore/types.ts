import type { DashboardRange } from "@/lib/views/dashboards/links";
import type { DashboardFilters, WidgetInput } from "@/lib/views/dashboards/types";

export const MAX_PANELS = 4;

/** What the Explore page shows: it is all in the address, and nothing is stored. */
export interface ExploreView {
  panels: readonly WidgetInput[];
  filters: DashboardFilters;
  range: DashboardRange | null;
}
