import type { Registration } from "@/lib/contracts/registry";
import { buildProjectTraceTurns, enqueueDueTraceTurnBuilds } from "./turns/build-job";
import { parseBuildJobRequest } from "./turns/queries";

/**
 * What the ledger contributes to the background machinery: the `build_trace_turns` job
 * and the cron safety net that enqueues one for every project with unbuilt events or
 * idle open turns, before the drain so the same tick runs what it enqueues. The step
 * reports under upstream's heartbeat key.
 */
export const ledgerRegistration: Registration = {
  jobs: {
    build_trace_turns: (job) =>
      buildProjectTraceTurns(job.projectId, {}, parseBuildJobRequest(job.payload)),
  },
  drainSteps: [
    {
      name: "trace_turns_build_enqueue",
      phase: "before",
      run: async () => ({ traceTurnBuildsEnqueued: (await enqueueDueTraceTurnBuilds()).enqueued }),
    },
  ],
};
