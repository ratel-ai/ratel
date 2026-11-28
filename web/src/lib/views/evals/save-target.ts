import { sandboxOfTask } from "@/lib/readings/trace-signals/workflows/sandbox-tasks";
import type { EvalContent } from "./domain/eval";
import { defaultTask, type SaveTarget, saveTarget, type TaskRef } from "./domain/eval-target";
import type { EvalStore } from "./ports/eval-store";
import type { TaskLinks } from "./ports/task-links";

/**
 * What the "Save as eval case" dialog shows first: the tasks of the turn or of the run's trace, the
 * task it chooses, and the target eval of each task (decision `trace-to-eval`). Then the targets
 * of the request from what the person chose: one row in the eval of each chosen task.
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

/** What the person chose in the dialog. With no task: an eval of the project, or a new name. */
export type SaveChoice = {
  taskIds: readonly string[];
  /** The eval of each task that has more evals, by the task id. */
  evalOfTask: Readonly<Record<string, string>>;
  evalId?: string;
  newName?: string;
};

/** A target of the create request (`cases-api.ts`). */
export type RequestTarget =
  | { evalId: string }
  | { newEval: { name: string; taskId: string | null; content?: EvalContent } };

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
      // The task of a sandbox runs on its sandbox, whatever the newest version of the project is.
      const target = saveTarget(task, all, {
        scorers,
        sandboxName: sandboxOfTask(task.id) ?? sandboxName,
      });
      return [task.id, target] as const;
    }),
  );
  return {
    tasks,
    defaultTaskId: defaultTask(tasks, pageTaskId)?.id ?? null,
    targets: Object.fromEntries(targets),
    evals: all.map(({ id, name }) => ({ id, name })),
  };
}

/** The targets of the request, one for each chosen task. Null until each choice is made. */
export function chosenTargets(options: SaveOptions, choice: SaveChoice): RequestTarget[] | null {
  if (options.tasks.length === 0) {
    if (choice.evalId) return [{ evalId: choice.evalId }];
    const name = choice.newName?.trim();
    return name ? [{ newEval: { name, taskId: null } }] : null;
  }
  if (choice.taskIds.length === 0) return null;
  const targets = choice.taskIds.map((taskId) => {
    const target = options.targets[taskId];
    return target ? requestTarget(target, choice.evalOfTask[taskId]) : null;
  });
  return targets.every((target) => target !== null) ? targets : null;
}

function requestTarget(target: SaveTarget, chosenEvalId: string | undefined): RequestTarget | null {
  switch (target.kind) {
    case "existing":
      return { evalId: target.evalId };
    case "choose":
      return target.evals.some(({ id }) => id === chosenEvalId) && chosenEvalId
        ? { evalId: chosenEvalId }
        : null;
    case "new":
      return { newEval: { name: target.name, taskId: target.taskId, content: target.content } };
    case "named":
      return null;
  }
}
