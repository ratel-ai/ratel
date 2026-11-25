import { parseQuery } from "@/lib/contracts/query";
import {
  type BoundReadDb,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import { type QueryResult, runQuery } from "@/lib/synthesis/metrics/query";
import type { BrokenWidget, Widget, WidgetInput } from "@/lib/views/dashboards/types";
// What these modules own is read through what they register.
import "@/lib/views/scorers/metrics";
import "@/lib/views/dashboards/clusters";

/** Widgets read at once: a full dashboard must not take the whole connection pool. */
const CONCURRENCY = 4;

type Load = (
  projectId: string,
  widget: WidgetInput,
  scope: QueryScope,
) => Promise<QueryResult | null>;

/** One widget's numbers, bounded, or null when the read failed. */
export const loadWidget = (
  projectId: string,
  widget: WidgetInput,
  scope: QueryScope,
  /** Another database than the pool's, in tests. */
  db?: BoundReadDb,
): Promise<QueryResult | null> =>
  loadOrFallback<QueryResult | null>({
    operation: "dashboard_widget",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: () =>
      withStatementTimeout((db) => runQuery(projectId, widget.query, scope, db), {
        operation: "dashboard_widget",
        timeoutMs: supplementaryReadTimeoutMs(),
        db,
      }),
  });

/** Every widget's numbers, in order. One that is broken, failed or waits for a scorer is null. */
export async function loadWidgets(
  projectId: string,
  widgets: readonly (
    | (WidgetInput & Pick<Widget, "missingScorer">)
    | Pick<BrokenWidget, "problem">
  )[],
  scope: QueryScope,
  load: Load = (project, widget, at) => loadWidget(project, widget, at),
): Promise<(QueryResult | null)[]> {
  const results: (QueryResult | null)[] = new Array(widgets.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < widgets.length) {
      const index = next++;
      const widget = widgets[index];
      if ("problem" in widget || widget.missingScorer) continue;
      if (!parseQuery(widget.query).ok) continue;
      results[index] = await load(projectId, widget, scope);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}
