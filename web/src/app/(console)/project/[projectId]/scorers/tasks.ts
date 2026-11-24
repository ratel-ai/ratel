import { taskNames } from "@/lib/views/tasks/model";
import { loadTasksInputs } from "@/lib/views/tasks/page-model";

/** A task a scorer may be scoped to. */
export interface TaskOption {
  id: string;
  name: string;
}

/** The project's tasks by name, with the one a scorer already has even when it is gone. */
export async function loadTaskOptions(
  projectId: string,
  current?: string | null,
): Promise<TaskOption[]> {
  const { stored, labels, names } = await loadTasksInputs(projectId);
  const tasks = [...taskNames(stored, labels, names)].map(([id, name]) => ({ id, name }));
  if (current && !tasks.some((task) => task.id === current))
    tasks.push({ id: current, name: `${current} (no longer found)` });
  return tasks.sort((a, b) => a.name.localeCompare(b.name));
}
