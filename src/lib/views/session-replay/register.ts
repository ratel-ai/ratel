import type { Registration } from "@/lib/contracts/registry";
import { JOB_ASKS, jobAskFor } from "@/lib/jobs/job-ask";
import { inProjectLogContext } from "@/lib/jobs/project-context";
import { whatIfStepJob } from "./job";
import { pruneWhatIfRuns, type WhatIfJobPayload } from "./runs";
import "./spend";

/**
 * What session replay contributes to the background machinery: the `what_if_step` job, one
 * queued What-if run sampled in the worker (ADR-0031), and the drain's `what_if_prune` step,
 * which deletes runs past their 30-day TTL and times out live ones that outlived the stale
 * window. The step is deliberately not retention-only: a timed-out run must free its hold on
 * the daily budget. It keeps upstream's heartbeat keys. No
 * upstream counterpart: upstream lists the handler in its job hub and the step in its drain.
 */
export const sessionReplayRegistration: Registration = {
  // In the project's log context, so `model_call` lines carry the project and organization.
  jobs: {
    what_if_step: inProjectLogContext(jobAskFor<WhatIfJobPayload>(JOB_ASKS.what_if_step), (job) =>
      whatIfStepJob(job.projectId, job.payload),
    ),
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
