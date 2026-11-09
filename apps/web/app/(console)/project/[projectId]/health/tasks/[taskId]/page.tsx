import { redirect } from "next/navigation";
import { TaskGone } from "@/components/console/tasks/TaskGone";
import { TasksNoDatabase } from "@/components/console/tasks/TasksView";
import { TaskView } from "@/components/console/tasks/TaskView";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { stageSpineEnabled } from "@/lib/views/stage-spine-flag";
import { buildTaskDetail, taskNames } from "@/lib/views/tasks/model";
import { loadTaskExamples, loadTaskFixes, loadTasksInputs } from "@/lib/views/tasks/page-model";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";

export const dynamic = "force-dynamic";
export const metadata = { title: "Task · Agent health" };

/**
 * One task: its steps, self-corrections, issues and fixes, the intents it serves, and example
 * runs. With `FF_STAGE_SPINE` on, it redirects to the top-level task page. Owned (ADR-0030):
 * the project comes from the console scope.
 */
export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; taskId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId, taskId } = await params;
  if (stageSpineEnabled()) redirect(topLevelTasksHref(projectId, taskId, await searchParams));
  if (!isDbConfigured()) return <TasksNoDatabase />;
  const { project, organization } = await requireProjectScope(projectId);
  const [inputs, fixes] = await Promise.all([
    loadTasksInputs(project.id),
    loadTaskFixes(project.id, organization),
  ]);
  const task = buildTaskDetail(inputs, taskId, { fixes });
  // A task the latest reading no longer finds (its tools changed, or its runs stopped) is said, not a 404.
  if (!task) {
    return (
      <TaskGone
        projectId={project.id}
        known={taskNames(inputs.stored, inputs.labels, inputs.names).size > 0}
        reading={inputs.run !== null}
      />
    );
  }
  const examples = await loadTaskExamples(project.id, task, {}, inputs.names);
  return <TaskView projectId={project.id} task={task} examples={examples} now={new Date()} />;
}
