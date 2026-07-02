import { CloudApiError } from "./errors.js";
import type { CloudHttp } from "./http.js";
import type { RunMetrics } from "./types.js";

/** Cloud's `POST /api/v1/events` batch cap; the endpoint 413s above it. */
const MAX_RUN_METRICS_BATCH = 500;

export async function reportRunMetrics(
  http: CloudHttp,
  metrics: RunMetrics | RunMetrics[],
): Promise<void> {
  if (Array.isArray(metrics) && metrics.length > MAX_RUN_METRICS_BATCH) {
    throw new CloudApiError(
      `run-metrics batch too large: ${metrics.length} > ${MAX_RUN_METRICS_BATCH}`,
      413,
    );
  }
  const response = await http.request("/api/v1/events", {
    method: "POST",
    body: JSON.stringify(metrics),
  });
  if (!response.ok) {
    throw new CloudApiError(`run-metrics report failed (HTTP ${response.status})`, response.status);
  }
}
