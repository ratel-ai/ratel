import type { TaskFixSource } from "./model";
import type { TasksDb } from "./queries";

/**
 * What the task pages read from the tool crafter once it lands: the pending drafted changes,
 * each with the tools it touches and the task it composes. Empty, a task lists only the
 * fixes derived from its issues. Same pattern as `computeSeams` in the trace-signals reading.
 */
export interface TasksSeams {
  loadDrafts?: (
    projectId: string,
    db: TasksDb,
    names: ReadonlyMap<string, string>,
  ) => Promise<TaskFixSource[]>;
}

export const tasksSeams: TasksSeams = {};
