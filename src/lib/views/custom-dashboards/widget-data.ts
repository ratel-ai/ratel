import type { Pivot } from "@/lib/ingest/pivots/model";
import { listPivots } from "@/lib/ingest/pivots/store";
import { getDb } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { getLogger } from "@/lib/platform/logger";
import type { DashboardWidget } from "./model";
import { runWidgetQuery, type WidgetResult } from "./query";

/**
 * The data of a dashboard's widgets (RC-888): every widget's query runs at the
 * same time, each under the read timeout. One failed or slow widget reads
 * `failed` and leaves the others as they are.
 */

export type WidgetData =
  | { widgetId: string; result: WidgetResult }
  | { widgetId: string; failed: true };

export interface WidgetDataDeps {
  pivots?: readonly Pick<Pivot, "key" | "presetId">[];
  run?: (
    projectId: string,
    spec: unknown,
    pivots: readonly Pick<Pivot, "key" | "presetId">[],
  ) => Promise<WidgetResult>;
  now?: Date;
}

const logger = getLogger("custom-dashboards/widget-data");

export async function loadWidgetData(
  projectId: string,
  widgets: readonly Pick<DashboardWidget, "id" | "spec">[],
  deps: WidgetDataDeps = {},
): Promise<WidgetData[]> {
  if (widgets.length === 0) return [];
  const now = deps.now ?? new Date();
  const pivots = deps.pivots ?? (await listPivots(projectId, getDb()));
  const run =
    deps.run ??
    ((id: string, spec: unknown, configured: readonly Pick<Pivot, "key" | "presetId">[]) =>
      withStatementTimeout((db) => runWidgetQuery(id, spec, { db, now, pivots: configured }), {
        operation: "dashboard_widget_query",
      }));
  return Promise.all(
    widgets.map(async (widget): Promise<WidgetData> => {
      try {
        return { widgetId: widget.id, result: await run(projectId, widget.spec, pivots) };
      } catch (err) {
        logger.error(
          { err, project_id: projectId, widget_id: widget.id },
          "dashboard widget query failed",
        );
        return { widgetId: widget.id, failed: true };
      }
    }),
  );
}
