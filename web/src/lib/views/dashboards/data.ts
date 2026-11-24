import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { getMetric, type MetricFeatures, metricOffered } from "@/lib/synthesis/metrics/catalog";
import { type MetricResult, queryMetric } from "@/lib/synthesis/metrics/query";
import type { WidgetInput } from "@/lib/views/dashboards/types";
// The scorer metrics read through the source this module registers.
import "@/lib/views/scorers/metrics";

/** Widgets read at once: a full dashboard must not take the whole connection pool. */
const CONCURRENCY = 4;

type Load = (
  projectId: string,
  widget: WidgetInput,
  window: { since: Date; until: Date },
) => Promise<MetricResult | null>;

/** One widget's numbers, bounded, or null when the read failed. */
export const loadWidget: Load = (projectId, widget, window) =>
  loadOrFallback<MetricResult | null>({
    operation: "dashboard_widget",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: () =>
      withStatementTimeout(
        (db) =>
          queryMetric(
            projectId,
            {
              metric: widget.metric,
              aggregation: widget.aggregation,
              groupBy: widget.groupBy,
              filter: widget.filter,
              scorerId: widget.scorerId,
              window,
            },
            db,
          ),
        { operation: "dashboard_widget", timeoutMs: supplementaryReadTimeoutMs() },
      ),
  });

/** Every widget's numbers, in order. A failed one, or one whose switch is off, is null. */
export async function loadWidgets(
  projectId: string,
  widgets: readonly WidgetInput[],
  window: { since: Date; until: Date },
  features: MetricFeatures,
  load: Load = loadWidget,
): Promise<(MetricResult | null)[]> {
  const results: (MetricResult | null)[] = new Array(widgets.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < widgets.length) {
      const index = next++;
      const metric = getMetric(widgets[index].metric);
      if (metric && !metricOffered(metric, features)) continue;
      results[index] = await load(projectId, widgets[index], window);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}
