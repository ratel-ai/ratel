import { getLogger, type LogFields } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";
import { readOldestQueuedJobAgeMs } from "./queries";

/**
 * The drain's outcome in the logs (owned port of upstream's `observeDrain`,
 * `lib/cron/background-drain.ts`, which is not part of this edition). A scheduler only sees the
 * HTTP answer and the worker's sweep sees nothing, so the heartbeat lives in the logs:
 * `drain_completed` after every drain, with the queue lag, and `job_queue_lagging` when the
 * oldest queued job has waited too long. The deployment's Datadog drain monitors match these
 * codes as bare text, so renaming one silences its alert.
 *
 * Upstream also holds a per-task slot and a watchdog, because its tick answers at once and drains
 * after the response. Here the tick runs inside the request (and the worker's loop runs one step
 * at a time), so neither applies.
 */

/** A queued job older than this after a drain logs `job_queue_lagging`. */
export const JOB_QUEUE_LAG_MS = 10 * 60 * 1000;

export type DrainLogCode =
  | "drain_started"
  | "drain_completed"
  | "drain_failed"
  | "drain_queue_lag_read_failed"
  | "job_queue_lagging";

export interface DrainObserverDeps {
  oldestQueuedJobAgeMs: () => Promise<number | null>;
  log: (level: "info" | "warn" | "error", fields: LogFields, code: DrainLogCode) => void;
  reportException: (error: unknown, properties: Record<string, unknown>) => void;
}

const logger = getLogger("jobs/drain");

export const defaultDrainObserverDeps: DrainObserverDeps = {
  oldestQueuedJobAgeMs: () => readOldestQueuedJobAgeMs(),
  log: (level, fields, code) => logger[level](fields, code),
  reportException: (error, properties) => reportServerException(error, "system:cron", properties),
};

/**
 * Run one drain and log its outcome: `drain_started`, then `drain_completed` with the queue lag
 * (and `job_queue_lagging` past `JOB_QUEUE_LAG_MS`), or `drain_failed`. The cron route and the
 * worker's sweep both drain through it. It never throws: a failure is logged and reported.
 */
export async function observeDrain<T extends { ok: boolean; error?: string }>(
  drain: () => Promise<T>,
  deps: DrainObserverDeps = defaultDrainObserverDeps,
): Promise<T | null> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  deps.log("info", {}, "drain_started");
  try {
    const result = await drain();
    if (!result.ok) {
      deps.log("error", { duration_ms: elapsed(), error: result.error }, "drain_failed");
      return result;
    }
    const queue = await queueLag(deps);
    deps.log("info", { duration_ms: elapsed(), ok: true, ...queue }, "drain_completed");
    if ((queue.oldest_queued_age_ms ?? 0) >= JOB_QUEUE_LAG_MS) {
      deps.log("warn", { ...queue, threshold_ms: JOB_QUEUE_LAG_MS }, "job_queue_lagging");
    }
    return result;
  } catch (error) {
    deps.log("error", { err: error, duration_ms: elapsed() }, "drain_failed");
    deps.reportException(error, { operation: "background_drain" });
    return null;
  }
}

/** The queue lag after a drain; a failed read only drops the field. */
async function queueLag(deps: DrainObserverDeps): Promise<{ oldest_queued_age_ms?: number }> {
  try {
    const age = await deps.oldestQueuedJobAgeMs();
    return { oldest_queued_age_ms: age ?? 0 };
  } catch (error) {
    deps.log("warn", { err: error }, "drain_queue_lag_read_failed");
    return {};
  }
}
