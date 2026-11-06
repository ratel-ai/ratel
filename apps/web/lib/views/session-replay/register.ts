import type { Registration } from "@/lib/contracts/registry";
import { whatIfStepJob } from "./job";
import { pruneWhatIfRuns, WHAT_IF_JOB } from "./runs";
import "./spend";

/**
 * What session replay contributes to the background machinery: the `what_if_step` job, one
 * queued What-if run sampled in the worker (ADR-0031), and the drain's `what_if_prune` step,
 * which deletes runs past their 30-day TTL and times out live ones that outlived the stale
 * window. The step is deliberately not retention-only: a timed-out run must free its hold on
 * the daily budget. It keeps upstream's heartbeat keys. The job checks `FF_SESSION_REPLAY`
 * itself, so a run queued before the flag was turned off is failed rather than sampled. No
 * upstream counterpart: upstream lists the handler in its job hub and the step in its drain.
 */
export const sessionReplayRegistration: Registration = {
  jobs: {
    [WHAT_IF_JOB]: (job) => whatIfStepJob(job.projectId, job.payload),
  },
  drainSteps: [
    {
      name: "what_if_prune",
      phase: "after",
      run: async () => {
        const { pruned, timedOut } = await pruneWhatIfRuns();
        return { whatIfRunsPruned: pruned, whatIfRunsTimedOut: timedOut };
      },
    },
  ],
};
