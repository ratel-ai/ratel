import type { Registration } from "@/lib/contracts/registry";
import { jobAskSpec } from "@/lib/jobs/job-ask";
import { inProjectLogContext } from "@/lib/jobs/project-context";
import type { SimulateFixEvalPayload } from "@/lib/views/eval-gate/job";
import { refreshTaskEvalSetJob } from "@/lib/views/task-evals/job";
import { simulateTaskEvalJob } from "@/lib/views/task-evals/simulation-job";
import "./ship";
import "./spend";

/**
 * The task evals' registration (upstream's `refresh_task_eval_set` and `simulate_task_eval` lines
 * in `lib/jobs/handlers.ts`), run by the worker (ADR-0031): one task's eval set rebuilt from its
 * past runs (queued after live scoring for sets a week old, or by a person), and one queued
 * simulation of a fix on a task's set, or a post-ship measure. Each job checks `evalGate`
 * itself. Loads the task loop's spend readers for the budget checks and its shipment record
 * (`./ship`, the `fixSeams.recordShipment` filler).
 */
export const taskEvalsRegistration: Registration = {
  jobs: {
    refresh_task_eval_set: (job) => refreshTaskEvalSetJob(job.projectId, job.payload),
    // In the project's log context, so `model_call` lines carry the project and organization.
    simulate_task_eval: inProjectLogContext(
      jobAskSpec<SimulateFixEvalPayload>("Simulate a task eval", { runId: true }),
      (job) => simulateTaskEvalJob(job.projectId, job.payload),
    ),
  },
};
