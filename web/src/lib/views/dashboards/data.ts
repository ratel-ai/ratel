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
import { QueryError, runQuery } from "@/lib/synthesis/metrics/query";
import { textToRun } from "@/lib/views/dashboards/metric-rql";
import type {
  BrokenWidget,
  Widget,
  WidgetInput,
  WidgetRefusal,
  WidgetResult,
} from "@/lib/views/dashboards/types";
import { isMetricChart, queryMetric } from "@/lib/views/dashboards/widget";
// What these modules own is read through what they register.
import "@/lib/views/scorers/metrics";
import "@/lib/views/dashboards/clusters";
import "@/lib/synthesis/rql/query";
import { RQL_LIMITS } from "@/lib/synthesis/rql/compile";

/** Widgets read at once: a full dashboard must not take the whole connection pool. */
const CONCURRENCY = 4;
/** Widgets of kind sql read at once: no more than the RQL gate gives one project. */
const SQL_CONCURRENCY = RQL_LIMITS.parallelQueriesPerProject;

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
    ? loadSqlWidget(
        projectId,
        // A text of the form follows the window, as the form did.
        {
          ...widget.query,
          text: isMetricChart(widget.chart)
            ? textToRun(widget.query, widget.chart, scope)
            : widget.query.text,
        },
        scope,
        db,
      )
    : loadOrFallback<WidgetResult | null>({
        operation: "dashboard_widget",
        distinctId: `project:${projectId}`,
        fallback: null,
        load: () =>
          withStatementTimeout(
            // A filter on a property that is not indexed says so, as on a widget of kind sql.
            (db) => runQuery(projectId, widget.query, scope, db).catch(refusedOrThrow),
            { operation: "dashboard_widget", timeoutMs: supplementaryReadTimeoutMs(), db },
          ),
      });

/** The refusal of a query the person can fix (its code and the fix); any other error goes on. */
function refusedOrThrow(error: unknown): WidgetRefusal {
  if (error instanceof QueryError && error.detail)
    return { kind: "refused", message: error.message, ...error.detail };
  throw error;
}

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
  const readable = widgets.flatMap((widget, index) => {
    if ("problem" in widget || widget.missingScorer) return [];
    const query = parseQuery(widget.query);
    if (!query.ok) return [];
    const metric = queryMetric(query.query);
    if (metric && !metricOffered(metric, features)) return [];
    return [{ index, widget, sql: query.query.kind === "sql" }];
  });
  // Kind sql in its own lane, as wide as the RQL gate: a second reader waits for places, not fails.
  const lane = async (items: typeof readable, width: number) => {
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const { index, widget } = items[next++];
        results[index] = await load(projectId, widget, scope);
      }
    };
    await Promise.all(Array.from({ length: width }, worker));
  };
  await Promise.all([
    lane(
      readable.filter((item) => !item.sql),
      CONCURRENCY,
    ),
    lane(
      readable.filter((item) => item.sql),
      SQL_CONCURRENCY,
    ),
  ]);
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
    // A console run reads the whole range of the page, as a metric widget does.
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
