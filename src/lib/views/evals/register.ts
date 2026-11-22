import type { Registration } from "@/lib/contracts/registry";
import { JOB_ASKS, jobAskFor } from "@/lib/jobs/job-ask";
import { inProjectLogContext } from "@/lib/jobs/project-context";
import { createDrizzleEvalStore } from "./adapters/drizzle-store";
import { runEvalSetJob } from "./job";
import { enqueueDueNightlyEvalRuns } from "./nightly";
import { RUN_EVAL_SET_JOB, type RunEvalSetPayload } from "./run";
import {
  runEvalSimulationJob,
  SIMULATE_EVAL_SET_JOB,
  type SimulateEvalSetPayload,
} from "./simulation";
import "./spend";

/**
 * What Evals contribute to the background machinery (FF_EVALS): the `run_eval_set` job (a run of
 * the eval set by hand or nightly) and the `simulate_eval_set` job (a fix replayed on the eval
 * set before and after), run by the worker (ADR-0031); the drain's `eval_nightly_enqueue` step
 * (one nightly run per opted-in paid project per UTC day) and `eval_transcript_prune` step
 * (replay text cleared after 30 days; verdicts and numbers stay). Each job and the nightly sweep
 * check `FF_EVALS` themselves, so a run queued before the switch was turned off is failed rather
 * than run. The heartbeat keys are upstream's. No upstream counterpart: upstream lists the
 * handlers in its job hub and the steps in its drain.
 */
export const evalsRegistration: Registration = {
  // In the project's log context, so `model_call` lines carry the project and organization.
  jobs: {
    [RUN_EVAL_SET_JOB]: inProjectLogContext(
      jobAskFor<RunEvalSetPayload>(JOB_ASKS.run_eval_set),
      (job) => runEvalSetJob(job.projectId, job.payload),
    ),
    [SIMULATE_EVAL_SET_JOB]: inProjectLogContext(
      jobAskFor<SimulateEvalSetPayload>(JOB_ASKS.simulate_eval_set),
      (job) => runEvalSimulationJob(job.projectId, job.payload),
    ),
  },
  drainSteps: [
    {
      name: "eval_nightly_enqueue",
      phase: "before",
      run: async () => ({ nightlyEvalRunsEnqueued: (await enqueueDueNightlyEvalRuns()).enqueued }),
    },
    {
      name: "eval_transcript_prune",
      phase: "after",
      run: async () => ({
        evalTranscriptsPruned: await createDrizzleEvalStore().pruneTranscripts(),
      }),
    },
  ],
};
