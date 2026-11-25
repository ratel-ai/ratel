import { taskNames } from "@/lib/views/tasks/model";
import { loadTasksInputs } from "@/lib/views/tasks/page-model";

/** A task a scorer may be attached to. */
export interface TaskOption {
  id: string;
  name: string;
}

/** The project's tasks by name, with the ones scorers already have even when they are gone. */
export async function loadTaskOptions(
  projectId: string,
  current: readonly string[] = [],
): Promise<TaskOption[]> {
  const { stored, labels, names } = await loadTasksInputs(projectId);
  const tasks = [...taskNames(stored, labels, names)].map(([id, name]) => ({ id, name }));
  for (const id of new Set(current))
    if (!tasks.some((task) => task.id === id)) tasks.push({ id, name: `${id} (no longer found)` });
  return tasks.sort((a, b) => a.name.localeCompare(b.name));
}
