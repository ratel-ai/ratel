import type { Registration } from "@/lib/contracts/registry";
import { computeSeams } from "@/lib/readings/trace-signals/signals/compute-job";
import { enqueueScoreTasksJob, scoreTasksJob } from "@/lib/views/task-scorers/job";
import "@/lib/views/task-evals/spend";

/**
 * The task scorers' registration (upstream's `score_tasks` line in `lib/jobs/handlers.ts`), and
 * what they supply to the signal run: a completed run queues the project's live task scores.
 * The queue checks `FF_EVAL_GATE` itself, so with the gate off nothing is queued. Loads the task
 * loop's spend reader, so the worker's budget checks count the live judge.
 */
export const computeSeamFills: Required<Pick<typeof computeSeams, "enqueueTaskScores">> = {
  enqueueTaskScores: (projectId) => enqueueScoreTasksJob(projectId),
};

export function fillComputeSeams(seams: typeof computeSeams = computeSeams): void {
  Object.assign(seams, computeSeamFills);
}

fillComputeSeams();

export const taskScorersRegistration: Registration = {
  jobs: {
    score_tasks: (job) => scoreTasksJob(job.projectId),
  },
};
