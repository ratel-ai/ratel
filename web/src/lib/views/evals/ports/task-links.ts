import type { EvalScorer } from "../domain/eval";
import type { TaskRef } from "../domain/eval-target";

/**
 * What evals read about tasks and sandboxes, by id only: the evals module does not import the
 * internals of the tasks module. The composition gives the real reads (`adapters/task-links.ts`).
 */
export interface TaskLinks {
  /** The tasks of the turn, each one time. Empty when no task matched it. */
  tasksOfTurn(projectId: string, turnId: string): Promise<TaskRef[]>;
  /** The tasks of the turns of a trace, each one time. */
  tasksOfTrace(projectId: string, traceId: string): Promise<TaskRef[]>;
  /** The default scorers of the task, as scorers of an eval. */
  defaultScorers(projectId: string, taskId: string): Promise<EvalScorer[]>;
  /** The sandbox of the newest ready version of the project. Null with none. */
  lastSandbox(projectId: string): Promise<string | null>;
}
