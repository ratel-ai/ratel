import { defaultTask, type SaveTarget, saveTarget, type TaskRef } from "./domain/eval-target";
import type { EvalStore } from "./ports/eval-store";
import type { TaskLinks } from "./ports/task-links";

/**
 * What the "Save as eval case" dialog shows first: the tasks of the turn or of the run's trace, the
 * task it chooses, and the target eval of each task (decision `trace-to-eval`).
 */
export type SaveOptions = {
  tasks: TaskRef[];
  /** Null: the person chooses a task, or there is none. */
  defaultTaskId: string | null;
  /** The target eval of each task, by the task id. */
  targets: Record<string, SaveTarget>;
  /** The evals of the project, for a turn with no task. */
  evals: Array<{ id: string; name: string }>;
};

export type SaveSource = { turnId: string } | { traceId: string } | null;

export type SaveOptionsDeps = { taskLinks: TaskLinks; evals: Pick<EvalStore, "list"> };

export async function saveOptions(
  projectId: string,
  source: SaveSource,
  pageTaskId: string | null,
  { taskLinks, evals }: SaveOptionsDeps,
): Promise<SaveOptions> {
  const [tasks, all] = await Promise.all([
    source === null
      ? []
      : "turnId" in source
        ? taskLinks.tasksOfTurn(projectId, source.turnId)
        : taskLinks.tasksOfTrace(projectId, source.traceId),
    evals.list(projectId),
  ]);
  const sandboxName = tasks.length > 0 ? await taskLinks.lastSandbox(projectId) : null;
  const targets = await Promise.all(
    tasks.map(async (task) => {
      const hasEval = all.some(({ taskId }) => taskId === task.id);
      const scorers = hasEval ? [] : await taskLinks.defaultScorers(projectId, task.id);
      return [task.id, saveTarget(task, all, { scorers, sandboxName })] as const;
    }),
  );
  return {
    tasks,
    defaultTaskId: defaultTask(tasks, pageTaskId)?.id ?? null,
    targets: Object.fromEntries(targets),
    evals: all.map(({ id, name }) => ({ id, name })),
  };
}
