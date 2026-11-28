import { TasksNoDatabase, TasksView } from "@/components/console/tasks/TasksView";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { loadPageProgress } from "@/lib/views/freshness/page";
import { buildTaskList } from "@/lib/views/tasks/model";
import { loadTaskFixes, loadTasksInputs } from "@/lib/views/tasks/page-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tasks" };

/**
 * Tasks at the project level. Owned (ADR-0004): the project comes from the console scope.
 */
export default async function TasksPage({ params }: { params: Promise<{ projectId: string }> }) {
  if (!isDbConfigured()) return <TasksNoDatabase />;
  const { projectId } = await params;
  const { project, organization } = await requireProjectScope(projectId);
  const [inputs, fixes, progress] = await Promise.all([
    loadTasksInputs(project.id, { selfCorrectionsTile: true }),
    loadTaskFixes(project.id, organization),
    loadPageProgress(project.id, "tasks"),
  ]);
  const model = buildTaskList(inputs, { fixes });
  return (
    <TasksView projectId={project.id} model={model} now={new Date()} topLevel progress={progress} />
  );
}
