import { listInFlightJobs } from "@/lib/jobs/queries";
import { drainProjectJobs } from "@/lib/jobs/store";

export interface SettleQueueDeps {
  /** The project's queued and running jobs (`listInFlightJobs`). */
  inFlight: (projectId: string) => Promise<ReadonlyArray<{ status: string }>>;
  drain: (projectId: string) => Promise<{ done: number; failed: number }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
}

const defaultDeps: SettleQueueDeps = {
  inFlight: (projectId) => listInFlightJobs(projectId),
  drain: (projectId) => drainProjectJobs(projectId),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Bring a project's queue to empty after a seed tick; false when `timeoutMs` passes first.
 *
 * A worker (`APP_ROLE=worker`) or an in-process scheduler may claim the seeded project's jobs
 * before the seed's own tick does, and the per-project running cap then makes that tick claim
 * nothing. So a job another process runs is waited for, and what is left queued is drained
 * here. Every tick then ends with the project's work done, whoever ran it, and the seed's
 * result does not depend on whether a worker is up.
 */
export async function settleProjectQueue(
  projectId: string,
  deps: SettleQueueDeps = defaultDeps,
): Promise<boolean> {
  const pollMs = deps.pollMs ?? 500;
  const deadline = deps.now() + (deps.timeoutMs ?? 120_000);
  for (;;) {
    const jobs = await deps.inFlight(projectId);
    if (jobs.length === 0) return true;
    if (deps.now() >= deadline) return false;
    if (jobs.some((job) => job.status === "running")) await deps.sleep(pollMs);
    else await deps.drain(projectId);
  }
}
