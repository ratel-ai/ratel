import { sandboxOfTask } from "@/lib/readings/trace-signals/workflows/sandbox-tasks";
import { datasetOf, type EvalContent } from "./domain/eval";
import { defaultTask, type SaveTarget, saveTarget, type TaskRef } from "./domain/eval-target";
import type { DatasetStore } from "./ports/dataset-store";
import type { EvalStore } from "./ports/eval-store";
import type { TaskLinks } from "./ports/task-links";

/**
 * What the "Save as eval case" dialog shows first: the tasks of the turn or of the run's trace, the
 * task it chooses, and the target eval of each task, with the dataset that the row goes into
 * (decision `trace-to-eval`). Then the targets of the request from what the person chose: one row
 * in the dataset of the eval of each chosen task. With no task, a fixed dataset that the person
 * chooses or names.
 */
export type SaveOptions = {
  tasks: TaskRef[];
  /** Null: the person chooses a task, or there is none. */
  defaultTaskId: string | null;
  /** The target eval of each task, by the task id. */
  targets: Record<string, SaveTarget>;
  /** The evals of the project. */
  evals: Array<{ id: string; name: string }>;
  /** The fixed datasets of the project, for a turn with no task. */
  datasets: Array<{ id: string; name: string }>;
  /** The name of the dataset of each eval, by the eval id. */
  datasetOfEval: Record<string, string>;
};

export type SaveSource = { turnId: string } | { traceId: string } | null;

export type SaveOptionsDeps = {
  taskLinks: TaskLinks;
  evals: Pick<EvalStore, "list">;
  datasets: Pick<DatasetStore, "list">;
};

/** What the person chose in the dialog for the tasks of the turn. */
export type SaveChoice = {
  taskIds: readonly string[];
  /** The eval of each task that has more evals, by the task id. */
  evalOfTask: Readonly<Record<string, string>>;
};

/** With no task: a fixed dataset of the project, or the name of a new one. */
export type DatasetChoice = { datasetId?: string; newName?: string };

/** A target of the create request (`cases-api.ts`). */
export type RequestTarget =
  | { evalId: string }
  | { newEval: { name: string; taskId: string | null; content?: EvalContent } };

export async function saveOptions(
  projectId: string,
  source: SaveSource,
  pageTaskId: string | null,
  { taskLinks, evals, datasets }: SaveOptionsDeps,
): Promise<SaveOptions> {
  const [tasks, all, summaries] = await Promise.all([
    source === null
      ? []
      : "turnId" in source
        ? taskLinks.tasksOfTurn(projectId, source.turnId)
        : taskLinks.tasksOfTrace(projectId, source.traceId),
    evals.list(projectId),
    datasets.list(projectId),
  ]);
  const names = new Map(summaries.map(({ id, name }) => [id, name]));
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
    datasets: summaries
      .filter(({ query }) => query.kind === "fixed")
      .map(({ id, name }) => ({ id, name })),
    datasetOfEval: Object.fromEntries(
      all.flatMap((definition) => {
        const name = names.get(datasetOf(definition));
        return name ? [[definition.id, name]] : [];
      }),
    ),
  };
}

/** The targets of the request, one for each chosen task. Null until each choice is made. */
export function chosenTargets(options: SaveOptions, choice: SaveChoice): RequestTarget[] | null {
  if (options.tasks.length === 0 || choice.taskIds.length === 0) return null;
  const targets = choice.taskIds.map((taskId) => {
    const target = options.targets[taskId];
    return target ? requestTarget(target, choice.evalOfTask[taskId]) : null;
  });
  return targets.every((target) => target !== null) ? targets : null;
}

/** With no task: the fixed dataset that the person chose, or the name of a new one. */
export function chosenDataset(
  options: Pick<SaveOptions, "datasets">,
  choice: DatasetChoice,
): { datasetId: string; name: string } | { newName: string } | null {
  if (choice.datasetId) {
    const found = options.datasets.find(({ id }) => id === choice.datasetId);
    return found ? { datasetId: found.id, name: found.name } : null;
  }
  const name = choice.newName?.trim();
  return name ? { newName: name } : null;
}

/**
 * The name of the dataset that a target puts the row into. A new eval gets a new fixed dataset with
 * its name. Null while the person has not chosen the eval.
 */
export function targetDataset(
  options: Pick<SaveOptions, "datasetOfEval">,
  target: SaveTarget | undefined,
  chosenEvalId: string | undefined,
): string | null {
  switch (target?.kind) {
    case "existing":
      return options.datasetOfEval[target.evalId] ?? null;
    case "choose":
      return chosenEvalId ? (options.datasetOfEval[chosenEvalId] ?? null) : null;
    case "new":
      return target.name;
    default:
      return null;
  }
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
