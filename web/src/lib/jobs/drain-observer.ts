import { type Config, getConfig } from "@/config";
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
 * The cron route's tick holds a per-process slot and its own watchdog (`background-drain.ts`); the
 * worker's sweep has `timedDrain`: the worker's loop runs one step at a time, so a sweep that
 * never settles would stop the analysis lane behind it.
 */

/**
 * How long a sweep may go with no finished job before the watchdog lets the worker go on. Each
 * finished job restarts it: one drain runs many jobs in sequence, so a healthy drain can run far
 * longer. A drain that never settles (an outbound call with no timeout) would otherwise hold the
 * worker's loop for good. Matches `STALE_JOB_MS`, after which its jobs are reaped too.
 * `CRON_DRAIN_TIMEOUT_MS` overrides it; `0` turns the watchdog off.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How many drains of one {@link timedDrain} may be unsettled at once: a hung one and its
 * replacement. A hang that lasts must not stop the sweeps for good, and hangs must not add up
 * without limit.
 */
const MAX_UNSETTLED_DRAINS = 2;

/** A queued job older than this after a drain logs `job_queue_lagging`. */
export const JOB_QUEUE_LAG_MS = 10 * 60 * 1000;

export type DrainLogCode =
  | "drain_started"
  | "drain_progress"
  | "drain_completed"
  | "drain_failed"
  | "drain_timed_out"
  | "drain_skipped_busy"
  | "drain_skipped_hung"
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
  fields: () => LogFields = () => ({}),
): Promise<T | null> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  deps.log("info", {}, "drain_started");
  try {
    const result = await drain();
    if (!result.ok) {
      deps.log(
        "error",
        { duration_ms: elapsed(), error: result.error, ...fields() },
        "drain_failed",
      );
      return result;
    }
    const queue = await queueLag(deps);
    deps.log(
      "info",
      { duration_ms: elapsed(), ok: true, ...fields(), ...queue },
      "drain_completed",
    );
    if ((queue.oldest_queued_age_ms ?? 0) >= JOB_QUEUE_LAG_MS) {
      deps.log("warn", { ...queue, threshold_ms: JOB_QUEUE_LAG_MS }, "job_queue_lagging");
    }
    return result;
  } catch (error) {
    deps.log("error", { err: error, duration_ms: elapsed(), ...fields() }, "drain_failed");
    deps.reportException(error, { operation: "background_drain" });
    return null;
  }
}

/** The default watchdog limit, `jobs.drainTimeoutMs` (CRON_DRAIN_TIMEOUT_MS). */
export function drainTimeoutMs(config: Pick<Config, "jobs"> = getConfig()): number {
  return config.jobs.drainTimeoutMs;
}

/**
 * The worker's sweep with a watchdog (upstream's `timedDrain`): observed like any drain, but it
 * returns once `limitMs` passes with no finished job (each one restarts the limit through the
 * `onProgress` it hands the drain), logging `drain_timed_out` and reporting it. A drain that
 * settles late logs its outcome, marked `timed_out`. With two drains unsettled, the next one is
 * skipped (`drain_skipped_hung`) until one settles. Null when the drain threw, timed out or was
 * skipped.
 */
export function timedDrain<T extends { ok: boolean; error?: string }>(
  drain: (onProgress: () => void) => Promise<T>,
  limitMs: number,
  deps: DrainObserverDeps = defaultDrainObserverDeps,
): () => Promise<T | null> {
  const unsettled = new Set<{ startedAt: number }>();
  return async () => {
    if (unsettled.size >= MAX_UNSETTLED_DRAINS) {
      const oldest = Math.min(...[...unsettled].map((run) => run.startedAt));
      deps.log("error", { running_for_ms: Date.now() - oldest }, "drain_skipped_hung");
      return null;
    }
    const run = { startedAt: Date.now() };
    unsettled.add(run);
    return new Promise<T | null>((resolve) => {
      let timedOut = false;
      const watchdog = progressWatchdog(limitMs, run.startedAt, deps, () => {
        timedOut = true;
        deps.log(
          "error",
          { duration_ms: Date.now() - run.startedAt, timeout_ms: limitMs },
          "drain_timed_out",
        );
        deps.reportException(new Error("background drain timed out"), {
          operation: "background_drain",
          timeout_ms: limitMs,
        });
        resolve(null);
      });
      void observeDrain(
        () => drain(watchdog.progress),
        deps,
        () => (timedOut ? { timed_out: true } : {}),
      ).then((result) => {
        unsettled.delete(run);
        watchdog.stop();
        resolve(result);
      });
    });
  };
}

/** The limit that each finished job restarts; it fires once, and never with `limitMs` of 0. */
export function progressWatchdog(
  limitMs: number,
  startedAt: number,
  deps: Pick<DrainObserverDeps, "log">,
  onTimeout: () => void,
): { progress: () => void; stop: () => void } {
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    if (limitMs <= 0) return;
    timer = setTimeout(() => {
      fired = true;
      onTimeout();
    }, limitMs);
    timer.unref?.();
  };
  arm();
  return {
    progress: () => {
      if (fired) return;
      deps.log("info", { duration_ms: Date.now() - startedAt }, "drain_progress");
      arm();
    },
    stop: () => clearTimeout(timer),
  };
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
