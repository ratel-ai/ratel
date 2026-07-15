import { CloudApiError } from "./errors.js";
import type { CloudHttp } from "./http.js";
import type { RunMetrics } from "./types.js";

/** Cloud's `POST /api/v1/events` batch cap; the endpoint 413s above it. */
const MAX_RUN_METRICS_BATCH = 500;

const CATEGORY_KEYS = ["skills", "tools", "history", "memory", "user_input"] as const;

function isNonNeg(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Mirrors Cloud's zod schema for `POST /api/v1/events` (categories are
 * non-negative numbers — floats allowed; only `input_tokens`/`output_tokens`
 * are integer-constrained). Returns the first violation, or null when valid.
 */
function firstViolation(record: RunMetrics): string | null {
  const raw = record as unknown as Record<string, unknown>;
  const categories = (raw.tokens_by_category ?? {}) as Record<string, unknown>;
  for (const key of CATEGORY_KEYS) {
    if (!isNonNeg(categories[key])) return `tokens_by_category.${key} must be a number >= 0`;
  }
  for (const group of ["saved_by_category", "saveable_by_category"] as const) {
    const partial = raw[group] as Record<string, unknown> | undefined;
    if (partial === undefined) continue;
    for (const key of CATEGORY_KEYS) {
      const v = partial[key];
      if (v !== undefined && !isNonNeg(v)) return `${group}.${key} must be a number >= 0`;
    }
  }
  for (const field of ["input_tokens", "output_tokens"] as const) {
    const v = raw[field];
    if (v !== undefined && (!isNonNeg(v) || !Number.isInteger(v))) {
      return `${field} must be an integer >= 0`;
    }
  }
  for (const field of ["latency_ms", "cost_usd"] as const) {
    const v = raw[field];
    if (v !== undefined && !isNonNeg(v)) return `${field} must be a number >= 0`;
  }
  if (typeof raw.model === "string" && raw.model.length > 200) {
    return "model must be at most 200 chars";
  }
  if (typeof raw.occurred_at === "string" && Number.isNaN(Date.parse(raw.occurred_at))) {
    return "occurred_at must be a parseable timestamp";
  }
  return null;
}

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
  // Cloud validates the batch all-or-nothing (one bad record 400s everything),
  // so fail fast here before spending the request.
  const batch = Array.isArray(metrics) ? metrics : [metrics];
  for (let i = 0; i < batch.length; i++) {
    const violation = firstViolation(batch[i]);
    if (violation) {
      throw new CloudApiError(`invalid run-metrics record [${i}]: ${violation}`, 400);
    }
  }
  const response = await http.request("/api/v1/events", {
    method: "POST",
    body: JSON.stringify(metrics),
  });
  if (!response.ok) {
    throw new CloudApiError(`run-metrics report failed (HTTP ${response.status})`, response.status);
  }
}
