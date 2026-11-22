import type { DrainStep, Registration } from "@/lib/contracts/registry";
import { computeSeams } from "@/lib/readings/trace-signals/signals/compute-job";
import {
  enqueueDueTaskScores,
  enqueueScoreTasksJob,
  scoreTasksJob,
} from "@/lib/views/task-scorers/job";
import "@/lib/views/task-evals/spend";

/**
 * The task scorers' registration (upstream's `score_tasks` line in `lib/jobs/handlers.ts`), and
 * what they supply to the signal run: a completed run queues the project's live task scores.
 * The queue checks `FF_EVAL_GATE` itself: with the gate off it queues nothing, and records the
 * refusal as a finished job with one `task_scores_skipped` event. Loads the task
 * loop's spend reader, so the worker's budget checks count the live judge.
 */
export const computeSeamFills: Required<Pick<typeof computeSeams, "enqueueTaskScores">> = {
  enqueueTaskScores: (projectId) => enqueueScoreTasksJob(projectId),
};

export function fillComputeSeams(seams: typeof computeSeams = computeSeams): void {
  Object.assign(seams, computeSeamFills);
}

fillComputeSeams();

/**
 * The drain's daily task-score sweep (upstream's `task_scores_enqueue` in `lib/cron/drain.ts`):
 * before the drain, so the same tick scores what it queues, and without waiting for a signal run,
 * which may not end `completed`. The heartbeat keeps upstream's `taskScoresEnqueued`.
 */
export function taskScoresEnqueueStep(
  enqueue: () => Promise<{ enqueued: number }> = () => enqueueDueTaskScores(),
): DrainStep {
  return {
    name: "task_scores_enqueue",
    phase: "before",
    run: async () => ({ taskScoresEnqueued: (await enqueue()).enqueued }),
  };
}

export const taskScorersRegistration: Registration = {
  jobs: {
    score_tasks: (job) => scoreTasksJob(job.projectId),
  },
  drainSteps: [taskScoresEnqueueStep()],
};
