import type { Registration } from "@/lib/contracts/registry";
import { simulateFixEvalJob } from "./job";
import { SIMULATE_FIX_EVAL_JOB } from "./job-kind";

/**
 * What the eval gate contributes to the background machinery: the `simulate_fix_eval` job, one
 * queued simulation of a fix over its eval set, which the worker runs (ADR-0031). No drain step:
 * a run is queued by a person or an MCP client, never by a sweep. The job checks `FF_EVAL_GATE`
 * itself, so a run queued before the gate was turned off is failed rather than simulated. No
 * upstream counterpart: upstream lists the handler in its job hub.
 */
export const evalGateRegistration: Registration = {
  jobs: {
    [SIMULATE_FIX_EVAL_JOB]: (job) => simulateFixEvalJob(job.projectId, job.payload),
  },
};
