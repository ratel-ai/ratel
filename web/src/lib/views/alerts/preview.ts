import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { getMetric } from "@/lib/synthesis/metrics/catalog";
import { type MetricResult, runQuery } from "@/lib/synthesis/metrics/query";
import { evaluationWindow } from "@/lib/views/alerts/domain";
import { measureSqlValue } from "@/lib/views/alerts/sql-value";
import type { AlertQuery, AlertWindow } from "@/lib/views/alerts/types";
// The scorer metrics read through the source this module registers.
import "@/lib/views/scorers/metrics";

const PREVIEW_MS = 7 * 86_400_000;

/** What RQL text gives now over the alert's window, or why it gives nothing the rule can compare. */
export interface SqlAlertValue {
  kind: "sql_value";
  value: number | null;
  error: string | null;
}

export type AlertPreviewResult = MetricResult | SqlAlertValue;

/**
 * A metric: its last 7 days, by the hour when the alert's window is an hour or less. RQL text: its
 * value now, over the window, as the evaluator reads it. Null when the read failed.
 */
export async function loadAlertPreview(
  projectId: string,
  query: AlertQuery,
  windowMinutes: AlertWindow,
  now: Date = new Date(),
): Promise<AlertPreviewResult | null> {
  if (query.kind === "sql") {
    const measured = await measureSqlValue(projectId, query, evaluationWindow(windowMinutes, now));
    return "error" in measured
      ? { kind: "sql_value", value: null, error: measured.error }
      : { kind: "sql_value", value: measured.value, error: null };
  }
  const hourly =
    windowMinutes <= 60 && getMetric(query.measures[0].measure)?.buckets.includes("hour");
  return loadOrFallback<MetricResult | null>({
    operation: "alert_preview",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: () =>
      withStatementTimeout(
        (db) =>
          runQuery(
            projectId,
            { ...query, bucket: hourly ? "hour" : "day" },
            { since: new Date(now.getTime() - PREVIEW_MS), until: now },
            db,
          ),
        { operation: "alert_preview", timeoutMs: supplementaryReadTimeoutMs() },
      ),
  });
}
