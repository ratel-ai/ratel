/**
 * The production wiring of the generic runner: the database-backed store and the handlers the
 * composition registry collected. `drainProjectJobs` is what routes call after the response,
 * what the scheduler calls on its tick, and what the cron drain calls; all are safe to run at
 * once thanks to the atomic claim.
 */
import { jobHandlers } from "@/lib/composition/registry";
import type { JobHandler } from "@/lib/contracts/registry";
import {
  claimNextQueuedJob,
  markJobDone,
  markJobError,
  readJobQueueClock,
  reapStaleRunningJobs,
  STALE_JOB_MS,
} from "@/lib/jobs/queries";
import {
  type BackgroundObservabilityDeps,
  createBackgroundObservability,
  defaultBackgroundObservabilityDeps,
} from "./observability";
import { drainJobs, type JobStore } from "./runner";

export interface DrainProjectJobsDeps {
  reapStaleRunningJobs: typeof reapStaleRunningJobs;
  drainJobs: typeof drainJobs;
  jobStore: JobStore;
  /** Read lazily: the registry imports every module, and some of them import this file. */
  jobHandlers: () => Partial<Record<string, JobHandler>>;
  observability: BackgroundObservabilityDeps;
}

/** The runner's DB surface, backed by the platform database. */
export const dbJobStore: JobStore = {
  claimNextQueued: async (projectId, createdBefore) => {
    const row = await claimNextQueuedJob(projectId, createdBefore);
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.projectId,
      kind: row.kind,
      status: "running",
      payload: row.payload,
    };
  },
  markDone: markJobDone,
  markError: markJobError,
  queueClock: () => readJobQueueClock(),
};

const defaultDeps = (): DrainProjectJobsDeps => ({
  reapStaleRunningJobs,
  drainJobs,
  jobStore: dbJobStore,
  jobHandlers: () => jobHandlers(),
  observability: defaultBackgroundObservabilityDeps,
});

/**
 * Drain queued jobs (a project's, or all) through the registered handlers. First reaps any zombie
 * `running` jobs so they stop wedging the in-flight checks; best-effort, so a reaper hiccup never
 * blocks the drain itself.
 */
export async function drainProjectJobs(
  projectId?: string,
  deps: DrainProjectJobsDeps = defaultDeps(),
): Promise<{ done: number; failed: number }> {
  const observability = createBackgroundObservability(deps.observability);
  try {
    const count = await deps.reapStaleRunningJobs(new Date(observability.now() - STALE_JOB_MS));
    if (count > 0) await observability.trackSystemEvent("jobs_reaped", "system:jobs", { count });
  } catch (error) {
    observability.reportException("stale job reaper failed", error, "system:jobs", {
      operation: "reap_stale_jobs",
    });
  }
  // Bounded: a drain claims only jobs queued before it started, so a job a handler queues
  // mid-drain waits for the next drain instead of looping.
  return deps.drainJobs(deps.jobStore, deps.jobHandlers(), { projectId, observer: observability });
}
