import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  EMPTY_TRACE_FILTER_FACETS,
  getTraceFilterFacets,
} from "@/lib/synthesis/traces/trace-filters";
import { scorerOptions } from "@/lib/views/dashboards/scorer-options";

/** What the widget fields offer: the filter values of the range, and the scorers. */
export async function loadWidgetForm(projectId: string, range: { since: Date; until?: Date }) {
  const distinctId = `project:${projectId}`;
  const [facets, scorers] = await Promise.all([
    loadOrFallback({
      operation: "dashboard_facets",
      distinctId,
      fallback: EMPTY_TRACE_FILTER_FACETS,
      load: () =>
        withStatementTimeout(
          (db) => getTraceFilterFacets(projectId, range, db, undefined, { entities: true }),
          { operation: "dashboard_facets", timeoutMs: supplementaryReadTimeoutMs() },
        ),
    }),
    loadOrFallback({
      operation: "dashboard_scorers",
      distinctId,
      fallback: [],
      load: () => scorerOptions(projectId),
    }),
  ]);
  return { facets, scorers };
}
