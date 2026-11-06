import type { Registration } from "@/lib/contracts/registry";
import { refreshTaskEvalSetJob } from "@/lib/views/task-evals/job";
import "./spend";

/**
 * The task eval sets' registration (upstream's `refresh_task_eval_set` line in
 * `lib/jobs/handlers.ts`): one task's eval set rebuilt from its past runs, in the worker
 * (ADR-0031). Queued after live scoring for sets a week old, or by a person; the job checks
 * `FF_EVAL_GATE` itself. Loads the task loop's spend readers for the budget checks.
 */
export const taskEvalsRegistration: Registration = {
  jobs: {
    refresh_task_eval_set: (job) => refreshTaskEvalSetJob(job.projectId, job.payload),
  },
};
