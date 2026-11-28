import type { DrainStep, Registration } from "@/lib/contracts/registry";
import { computeSeams } from "@/lib/readings/trace-signals/signals/compute-job";
import { seedTaskPresets } from "@/lib/views/scorers/task-presets";
import {
  type EnqueueScoreTasksDeps,
  enqueueDueTaskScores,
  enqueueScoreTasksJob,
  scoreTasksJob,
} from "@/lib/views/task-scorers/job";
import "@/lib/views/task-evals/spend";

/**
 * The task scorers' registration (upstream's `score_tasks` line in `lib/jobs/handlers.ts`), and
 * what they supply to the signal run: a completed run queues the project's live task scores.
 * The queue checks `evalGate` itself: with the gate off it queues nothing, and records the
 * refusal as a finished job with one `task_scores_skipped` event. The top-level scorers do every
 * project's live scoring, so both triggers skip it the same way, and a `score_tasks` job queued
 * before writes nothing.
 * Loads the task loop's spend reader, so the worker's budget checks count the live judge.
 */
export const computeSeamFills: Required<Pick<typeof computeSeams, "enqueueTaskScores">> = {
  enqueueTaskScores: (projectId) => enqueueTaskScores(projectId),
};

export function fillComputeSeams(seams: typeof computeSeams = computeSeams): void {
  Object.assign(seams, computeSeamFills);
}

fillComputeSeams();

/** The top-level scorers do the live scoring of every project. */
const scorersOn = async () => true;
/** A new task gets its default presets when it is next due for scoring. */
const oneModel: Pick<EnqueueScoreTasksDeps, "scorersOn" | "seedPresets"> = {
  scorersOn,
  seedPresets: (projectId, now, db) => seedTaskPresets(projectId, now, db),
};

/** The signal run's trigger. */
export function enqueueTaskScores(projectId: string, deps: EnqueueScoreTasksDeps = {}) {
  return enqueueScoreTasksJob(projectId, { ...oneModel, ...deps });
}

/**
 * The drain's daily task-score sweep (upstream's `task_scores_enqueue` in `lib/cron/drain.ts`):
 * before the drain, so the same tick scores what it queues, and without waiting for a signal run,
 * which may not end `completed`. The heartbeat keeps upstream's `taskScoresEnqueued`.
 */
export function taskScoresEnqueueStep(
  enqueue?: () => Promise<{ enqueued: number }>,
  deps: EnqueueScoreTasksDeps = {},
): DrainStep {
  const run = enqueue ?? (() => enqueueDueTaskScores({ ...oneModel, ...deps }));
  return {
    name: "task_scores_enqueue",
    phase: "before",
    run: async () => ({ taskScoresEnqueued: (await run()).enqueued }),
  };
}

export const taskScorersRegistration: Registration = {
  jobs: {
    score_tasks: (job) => scoreTasksJob(job.projectId, { scorersOn }),
  },
  drainSteps: [taskScoresEnqueueStep()],
};
