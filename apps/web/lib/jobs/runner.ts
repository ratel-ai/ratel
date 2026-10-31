/**
 * Generic async job runner, the durable backbone for background work. A route or action enqueues
 * a `queued` job row and returns immediately; this runner (kicked off by Next's `after()` after
 * the response, by the in-process scheduler, or by the cron drain) claims queued jobs, runs the
 * handler the registry supplies for their `kind`, and records the outcome.
 *
 * Pure orchestration: the store and the handlers are injected, so the claim, run, done/error
 * state machine is unit-testable without infrastructure. A handler throwing marks just that job
 * `error` and never aborts the drain.
 */
import type { JobHandler, JobRecord as RegistryJobRecord } from "@/lib/contracts/registry";
import { getLogger } from "@/lib/platform/logger";
import {
  type BackgroundObservability,
  type BackgroundObservabilityDeps,
  createBackgroundObservability,
} from "./observability";

export type { JobHandler };
/** Job kinds are open strings: each module registers the ones it handles. */
export type JobKind = string;
export type JobStatus = "queued" | "running" | "done" | "error";

/** The minimal job shape a handler needs (the claimed, now-`running` row). */
export interface JobRecord extends RegistryJobRecord {
  status: JobStatus;
}

/** The DB surface the runner drives; implemented by `lib/jobs/queries.ts`. */
export interface JobStore {
  /** Atomically claim the next `queued` job, or null when the queue is empty. */
  claimNextQueued(projectId?: string, createdBefore?: Date): Promise<JobRecord | null>;
  /** The instant a drain starts, on the clock the queue stamps `created_at` with. */
  queueClock?(): Promise<Date>;
  markDone(id: string, result: unknown): Promise<void>;
  markError(id: string, error: string): Promise<void>;
}

export interface DrainJobsOptions {
  projectId?: string;
  max?: number;
  observer?: BackgroundObservability;
  observability?: BackgroundObservabilityDeps;
}

const logger = getLogger("jobs/runner");

/**
 * Drain the jobs queued before the drain started until none is left (or the `max` safety cap is
 * hit). Jobs queued while it runs wait for the next drain. A missing handler or a throwing
 * handler marks that one job `error` and the loop continues.
 */
export async function drainJobs(
  store: JobStore,
  handlers: Partial<Record<string, JobHandler>>,
  opts: DrainJobsOptions = {},
): Promise<{ done: number; failed: number }> {
  const max = opts.max ?? 100;
  const observability =
    opts.observer ??
    (opts.observability ? createBackgroundObservability(opts.observability) : undefined);
  let done = 0;
  let failed = 0;
  const createdBefore = await store.queueClock?.();

  for (let i = 0; i < max; i++) {
    const job = await store.claimNextQueued(opts.projectId, createdBefore);
    if (!job) break;
    const startedAt = observability?.now() ?? Date.now();
    try {
      const handler = handlers[job.kind];
      if (!handler) throw new Error(`no handler for job kind: ${job.kind}`);
      const result = await handler(job);
      await store.markDone(job.id, result ?? null);
      await observability?.trackProjectEvent("job_completed", job.projectId, {
        kind: job.kind,
        job_id: job.id,
        duration_ms: Math.max(0, (observability?.now() ?? Date.now()) - startedAt),
      });
      done++;
    } catch (err) {
      const durationMs = Math.max(0, (observability?.now() ?? Date.now()) - startedAt);
      const eventProperties = { kind: job.kind, job_id: job.id, duration_ms: durationMs };
      const captureProperties = { ...eventProperties, project_id: job.projectId };
      if (observability) {
        observability.reportException(
          "job_failed",
          err,
          `project:${job.projectId}`,
          captureProperties,
        );
        await observability.trackProjectEvent("job_failed", job.projectId, eventProperties);
      } else {
        logger.error({ ...captureProperties, err }, "job_failed");
      }
      await store.markError(job.id, err instanceof Error ? err.message : String(err));
      failed++;
    }
  }

  return { done, failed };
}
