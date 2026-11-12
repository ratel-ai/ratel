import { notFound } from "next/navigation";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { evalGateEnabledFor } from "@/lib/views/eval-gate/gate";
import { loadFixes } from "@/lib/views/fixes/load";
import { stageSpineEnabled } from "@/lib/views/stage-spine-flag";
import { buildTaskDetail } from "@/lib/views/tasks/model";
import { loadTasksInputs } from "@/lib/views/tasks/page-model";

/**
 * Resolve page access before reading any simulation data. Owned (ADR-0030): the project comes
 * from the console scope; the stage spine is the env flag.
 */
export async function simulationPageContext(projectId: string, taskId: string) {
  if (!stageSpineEnabled() || !isDbConfigured()) notFound();
  const { project, organization } = await requireProjectScope(projectId);
  if (!(await evalGateEnabledFor(organization))) notFound();
  const [inputs, fixes] = await Promise.all([
    loadTasksInputs(project.id),
    loadFixes({ projectId: project.id, organization }),
  ]);
  const task = buildTaskDetail(inputs, taskId, { fixes: fixes.open });
  if (!task) notFound();
  return { project, task, fixes: [...fixes.open, ...fixes.applied] };
}
