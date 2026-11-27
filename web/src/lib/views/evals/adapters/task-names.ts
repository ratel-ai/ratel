import { sandboxOfTask } from "@/lib/readings/trace-signals/workflows/sandbox-tasks";
import { taskNames } from "@/lib/views/tasks/model";
import { loadTasksInputs } from "@/lib/views/tasks/page-model";

/**
 * The tasks of the project by id, with their names, for the task pickers of the Datasets and Evals
 * pages. The task of a sandbox is named by its sandbox until a signal run names it. A failed read
 * gives no task: a picker then takes no task, and the page still works.
 */
export async function projectTaskNames(projectId: string): Promise<Map<string, string>> {
  try {
    const { stored, labels, names } = await loadTasksInputs(projectId);
    const known = taskNames(stored, labels, names);
    return new Map(
      [...known].map(([id, name]) => [id, name === id ? (sandboxOfTask(id) ?? name) : name]),
    );
  } catch {
    return new Map();
  }
}
