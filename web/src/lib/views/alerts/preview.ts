import { getMetric } from "@/lib/synthesis/metrics/catalog";
import { type MetricResult, QueryError, runQuery } from "@/lib/synthesis/metrics/query";
import { evaluationWindow } from "@/lib/views/alerts/domain";
import { measureSqlValue } from "@/lib/views/alerts/sql-value";
import type { AlertQuery, AlertWindow } from "@/lib/views/alerts/types";
import { formQuery } from "@/lib/views/dashboards/metric-rql";
import { formAsMetric } from "@/lib/views/dashboards/sql-chart";
// Kind sql runs through the seam this module registers.
import "@/lib/synthesis/rql/query";

const PREVIEW_MS = 7 * 86_400_000;

/** What RQL text gives now over the alert's window, or why it gives nothing the rule can compare. */
export interface SqlAlertValue {
  kind: "sql_value";
  value: number | null;
  error: string | null;
}

export type AlertPreviewResult = MetricResult | SqlAlertValue;

/** Kind sql reads through the RQL pool: the primary database is never asked. */
const RQL_ONLY = {
  execute: () => Promise.reject(new Error("a query of kind sql reads through the RQL pool")),
} as unknown as Parameters<typeof runQuery>[3];

/**
 * A rule of the metric form: its last 7 days, by the hour when the alert's window is an hour or
 * less, read through RQL as the text of its selection by bucket. A Custom text: its value now,
 * over the window, as the evaluator reads it. Null when the read failed.
 */
export async function loadAlertPreview(
  projectId: string,
  query: AlertQuery,
  windowMinutes: AlertWindow,
  now: Date = new Date(),
): Promise<AlertPreviewResult | null> {
  const { form } = query;
  if (!form) {
    const measured = await measureSqlValue(projectId, query, evaluationWindow(windowMinutes, now));
    return "error" in measured
      ? { kind: "sql_value", value: null, error: measured.error }
      : { kind: "sql_value", value: measured.value, error: null };
  }
  const hourly =
    windowMinutes <= 60 && getMetric(form.measures[0].measure)?.buckets.includes("hour");
  const window = { since: new Date(now.getTime() - PREVIEW_MS), until: now };
  const series = { ...form, bucket: hourly ? ("hour" as const) : ("day" as const) };
  try {
    const result = await runQuery(
      projectId,
      formQuery(series, "line", series.bucket),
      window,
      RQL_ONLY,
    );
    return formAsMetric(result, series, "line", window);
  } catch (error) {
    if (error instanceof QueryError) return null;
    throw error;
  }
}
