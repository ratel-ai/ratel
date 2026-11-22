import type { Registration } from "@/lib/contracts/registry";
import { REFILL_PIVOT_DIMS_JOB } from "@/lib/jobs/kinds";
import { refillPivotDims } from "./refill";

/**
 * The pivots' registration (RC-884): the `refill_pivot_dims` job, which refills `dims` on the
 * project's trace summaries after a pivot is added or removed. Settings > Pivots queues it; the
 * cron drain runs it. With `FF_PIVOTS` off for the project the job ends at once and writes
 * nothing. Upstream lists the handler in its job hub (`lib/jobs/handlers.ts`).
 */
export const pivotsRegistration: Registration = {
  jobs: {
    [REFILL_PIVOT_DIMS_JOB]: (job) => refillPivotDims(job.projectId, job.id),
  },
};
