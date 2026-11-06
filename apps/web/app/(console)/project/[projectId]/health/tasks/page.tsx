import { redirect } from "next/navigation";
import { TasksNoDatabase, TasksView } from "@/components/console/tasks/TasksView";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { loadPageProgress } from "@/lib/views/freshness/page";
import { stageSpineEnabled } from "@/lib/views/stage-spine-flag";
import { buildTaskList } from "@/lib/views/tasks/model";
import { loadTaskFixes, loadTasksInputs } from "@/lib/views/tasks/page-model";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tasks · Agent health" };

/**
 * Agent health › Tasks: what the agent does for an ask, task by task, with the fixes Fixes lists
 * for each. With `FF_STAGE_SPINE` on, Tasks is a top-level page and this one redirects there.
 * Owned (ADR-0030): the project comes from the console scope.
 */
export default async function TasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  if (stageSpineEnabled()) redirect(topLevelTasksHref(projectId, undefined, await searchParams));
  if (!isDbConfigured()) return <TasksNoDatabase />;
  const { project, organization } = await requireProjectScope(projectId);
  const [inputs, fixes, progress] = await Promise.all([
    loadTasksInputs(project.id),
    loadTaskFixes(project.id, organization),
    loadPageProgress(project.id, "tasks"),
  ]);
  const model = buildTaskList(inputs, { fixes });
  return <TasksView projectId={project.id} model={model} now={new Date()} progress={progress} />;
}
