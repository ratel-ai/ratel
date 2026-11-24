import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { getMetric } from "@/lib/synthesis/metrics/catalog";
import { type MetricResult, queryMetric } from "@/lib/synthesis/metrics/query";
import type { AlertQuery, AlertWindow } from "@/lib/views/alerts/types";
// The scorer metrics read through the source this module registers.
import "@/lib/views/scorers/metrics";

const PREVIEW_MS = 7 * 86_400_000;

/** The last 7 days of a query, by the hour when the alert's window is an hour or less. Null when the read failed. */
export function loadAlertPreview(
  projectId: string,
  query: AlertQuery,
  windowMinutes: AlertWindow,
  now: Date = new Date(),
): Promise<MetricResult | null> {
  const hourly = windowMinutes <= 60 && getMetric(query.metric)?.buckets.includes("hour");
  return loadOrFallback<MetricResult | null>({
    operation: "alert_preview",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: () =>
      withStatementTimeout(
        (db) =>
          queryMetric(
            projectId,
            {
              ...query,
              window: { since: new Date(now.getTime() - PREVIEW_MS), until: now },
              bucket: hourly ? "hour" : "day",
            },
            db,
          ),
        { operation: "alert_preview", timeoutMs: supplementaryReadTimeoutMs() },
      ),
  });
}
