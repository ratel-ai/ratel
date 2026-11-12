import { notFound } from "next/navigation";
import { TasksNoDatabase, TasksView } from "@/components/console/tasks/TasksView";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { evalGateEnabledFor } from "@/lib/views/eval-gate/gate";
import { loadPageProgress } from "@/lib/views/freshness/page";
import { stageSpineEnabled } from "@/lib/views/stage-spine-flag";
import { loadTaskScores } from "@/lib/views/tasks/live-scores";
import { buildTaskList } from "@/lib/views/tasks/model";
import { loadTaskFixes, loadTasksInputs } from "@/lib/views/tasks/page-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tasks" };

/**
 * Show tasks at the project level when `FF_STAGE_SPINE` is on; live scores with `FF_EVAL_GATE`.
 * Owned (ADR-0030): the project comes from the console scope, and the stage spine is the env flag.
 */
export default async function TasksPage({ params }: { params: Promise<{ projectId: string }> }) {
  if (!stageSpineEnabled()) notFound();
  if (!isDbConfigured()) return <TasksNoDatabase />;
  const { projectId } = await params;
  const { project, organization } = await requireProjectScope(projectId);
  const [inputs, fixes, scoresEnabled, progress] = await Promise.all([
    loadTasksInputs(project.id),
    loadTaskFixes(project.id, organization),
    evalGateEnabledFor(organization),
    loadPageProgress(project.id, "tasks"),
  ]);
  const model = buildTaskList(inputs, { fixes });
  const now = new Date();
  const scores =
    scoresEnabled && model.state === "ready" ? await loadTaskScores(project.id, now) : undefined;
  return (
    <TasksView
      projectId={project.id}
      model={model}
      now={now}
      topLevel
      scores={scores}
      progress={progress}
    />
  );
}
