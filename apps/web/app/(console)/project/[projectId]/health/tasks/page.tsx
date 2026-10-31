import { TasksNoDatabase, TasksView } from "@/components/console/tasks/TasksView";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { buildTaskList } from "@/lib/views/tasks/model";
import { loadTaskFixes, loadTasksInputs } from "@/lib/views/tasks/page-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tasks · Agent health" };

/**
 * Agent health › Tasks: what the agent does for an ask, task by task, with the fixes Fixes lists
 * for each. Owned (ADR-0030): the project comes from the console scope.
 */
export default async function TasksPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (!isDbConfigured()) return <TasksNoDatabase />;
  const { project, organization } = await requireProjectScope(projectId);
  const [inputs, fixes] = await Promise.all([
    loadTasksInputs(project.id),
    loadTaskFixes(project.id, organization),
  ]);
  const model = buildTaskList(inputs, { fixes });
  return <TasksView projectId={project.id} model={model} now={new Date()} />;
}
