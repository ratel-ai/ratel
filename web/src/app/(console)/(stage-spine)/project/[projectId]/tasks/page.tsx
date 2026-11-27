import { TasksNoDatabase, TasksView } from "@/components/console/tasks/TasksView";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { evalGateEnabledFor } from "@/lib/views/eval-gate/gate";
import { loadPageProgress } from "@/lib/views/freshness/page";
import { loadTaskScores } from "@/lib/views/tasks/live-scores";
import { buildTaskList } from "@/lib/views/tasks/model";
import { loadTaskFixes, loadTasksInputs } from "@/lib/views/tasks/page-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tasks" };

/**
 * Tasks at the project level; daily live scores with `evalGate` and without `customMonitoring`. Owned (ADR-0004): the project
 * comes from the console scope.
 */
export default async function TasksPage({ params }: { params: Promise<{ projectId: string }> }) {
  if (!isDbConfigured()) return <TasksNoDatabase />;
  const { projectId } = await params;
  const { project, organization, user } = await requireProjectScope(projectId);
  const [inputs, fixes, evalGate, scorersOn, progress] = await Promise.all([
    loadTasksInputs(project.id),
    loadTaskFixes(project.id, organization),
    evalGateEnabledFor(organization),
    featureEnabled("customMonitoring", {
      projectId: project.id,
      organizationId: organization.id,
      actor: user.externalId,
    }),
    loadPageProgress(project.id, "tasks"),
  ]);
  const model = buildTaskList(inputs, { fixes });
  const now = new Date();
  // With customMonitoring on, the daily scores are no longer written: the task pages show the live ones.
  const scores =
    evalGate && !scorersOn && model.state === "ready"
      ? await loadTaskScores(project.id, now)
      : undefined;
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
