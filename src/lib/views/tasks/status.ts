/**
 * A task's status in one word, the same on the list and on its page:
 *
 * - Failing: an open "requests that fail partway" issue on the task.
 * - Slow: an open "requests that take too long" issue on the task.
 * - Watch: no such issue (often too few runs to raise one), but it finishes
 *   fewer than `WATCH.finishRate` of its runs, a step fails at least
 *   `WATCH.stepFailureShare` of its calls, or the agent corrects itself at
 *   least `WATCH.correctionsPer100` times per 100 runs.
 * - Healthy: none of these.
 *
 * Pure; the numbers it reads come from the task's reading.
 */

export type TaskStatus = "failing" | "slow" | "watch" | "healthy";

export type WatchReason = "finish" | "step" | "corrections";

export const WATCH = Object.freeze({
  finishRate: 0.9,
  stepFailureShare: 0.1,
  /** A step's failure share counts from this many calls. */
  stepMinCalls: 5,
  correctionsPer100: 25,
});

export const TASK_STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  failing: "Failing",
  slow: "Slow",
  watch: "Watch",
  healthy: "Healthy",
};

/** Sort rank: the tasks that need a look first. */
export const TASK_STATUS_RANK: Readonly<Record<TaskStatus, number>> = {
  failing: 0,
  slow: 1,
  watch: 2,
  healthy: 3,
};

export interface TaskStatusInput {
  /** Kinds of the open issues raised on the task itself. */
  issueKinds: ReadonlySet<string>;
  finishRate: number | null;
  weakest: { failureShare: number; calls: number } | null;
  correctionsPer100: number | null;
}

export function taskStatus(input: TaskStatusInput): {
  status: TaskStatus;
  reason: WatchReason | null;
} {
  if (input.issueKinds.has("workflow_failing")) return { status: "failing", reason: null };
  if (input.issueKinds.has("workflow_slow")) return { status: "slow", reason: null };
  if (input.finishRate !== null && input.finishRate < WATCH.finishRate)
    return { status: "watch", reason: "finish" };
  const step = input.weakest;
  if (step && step.calls >= WATCH.stepMinCalls && step.failureShare >= WATCH.stepFailureShare)
    return { status: "watch", reason: "step" };
  if (input.correctionsPer100 !== null && input.correctionsPer100 >= WATCH.correctionsPer100) {
    return { status: "watch", reason: "corrections" };
  }
  return { status: "healthy", reason: null };
}
