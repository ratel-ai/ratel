import { parseQuery } from "@/lib/contracts/query";
import {
  type BoundReadDb,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  type MetricFeatures,
  metricOffered,
  type QueryScope,
} from "@/lib/synthesis/metrics/catalog";
import { QueryError, type QueryResult, runQuery } from "@/lib/synthesis/metrics/query";
import type { BrokenWidget, Widget, WidgetInput, WidgetResult } from "@/lib/views/dashboards/types";
import { queryMetric } from "@/lib/views/dashboards/widget";
// What these modules own is read through what they register.
import "@/lib/views/scorers/metrics";
import "@/lib/views/dashboards/clusters";
import "@/lib/synthesis/rql/query";

/** Widgets read at once: a full dashboard must not take the whole connection pool. */
const CONCURRENCY = 4;

type Load = (
  projectId: string,
  widget: WidgetInput,
  scope: QueryScope,
) => Promise<WidgetResult | null>;

/**
 * One widget's numbers, bounded, or null when the read failed. A query of kind sql runs on the
 * read-only RQL path with its own limits, under the page's filter like the other kinds, and a refusal of RQL (a
 * compile or a run error) comes back as the message and the fix, for the person to correct.
 */
export const loadWidget = (
  projectId: string,
  widget: WidgetInput,
  scope: QueryScope,
  /** Another database than the pool's, in tests. */
  db?: BoundReadDb,
): Promise<WidgetResult | null> =>
  widget.query.kind === "sql"
    ? loadSqlWidget(projectId, widget.query, scope, db)
    : loadOrFallback<QueryResult | null>({
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

/** Every widget's numbers, in order. One that is broken, failed, waits for a scorer, or whose switch is off, is null. */
export async function loadWidgets(
  projectId: string,
  widgets: readonly (
    | (WidgetInput & Pick<Widget, "missingScorer">)
    | Pick<BrokenWidget, "problem">
  )[],
  scope: QueryScope,
  features: MetricFeatures,
  load: Load = (project, widget, at) => loadWidget(project, widget, at),
): Promise<(WidgetResult | null)[]> {
  const results: (WidgetResult | null)[] = new Array(widgets.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < widgets.length) {
      const index = next++;
      const widget = widgets[index];
      if ("problem" in widget || widget.missingScorer) continue;
      const query = parseQuery(widget.query);
      if (!query.ok) continue;
      const metric = queryMetric(query.query);
      if (metric && !metricOffered(metric, features)) continue;
      results[index] = await load(projectId, widget, scope);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

async function loadSqlWidget(
  projectId: string,
  query: Extract<WidgetInput["query"], { kind: "sql" }>,
  scope: QueryScope,
  db: BoundReadDb | undefined,
): Promise<WidgetResult | null> {
  try {
    // The runner of kind sql reads through the RQL pool: `db` is only the contract's argument.
    return await runQuery(projectId, query, scope, db);
  } catch (error) {
    if (error instanceof QueryError && error.detail)
      return { kind: "refused", message: error.message, ...error.detail };
    return loadOrFallback<null>({
      operation: "dashboard_widget",
      distinctId: `project:${projectId}`,
      fallback: null,
      load: () => Promise.reject(error),
    });
  }
}
