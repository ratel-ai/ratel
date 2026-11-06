import { buttonVariants } from "@ratel/design-system/button-variants";
import { Section } from "@ratel/design-system/section";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TaskEvals } from "@/app/(console)/project/[projectId]/tasks/[taskId]/TaskEvals";
import { TaskScoring } from "@/app/(console)/project/[projectId]/tasks/[taskId]/TaskScoring";
import { TaskGone } from "@/components/console/tasks/TaskGone";
import { TasksNoDatabase } from "@/components/console/tasks/TasksView";
import { TaskView } from "@/components/console/tasks/TaskView";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { evalGateEnabledFor } from "@/lib/views/eval-gate/gate";
import { sessionReplayEnabled } from "@/lib/views/session-replay-flag";
import { stageSpineEnabled } from "@/lib/views/stage-spine-flag";
import { taskEvalSetFor } from "@/lib/views/task-evals/store";
import { buildTaskDetail, taskNames } from "@/lib/views/tasks/model";
import { loadTaskExamples, loadTaskFixes, loadTasksInputs } from "@/lib/views/tasks/page-model";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";

export const dynamic = "force-dynamic";
export const metadata = { title: "Task" };

/**
 * Reuse the current task detail and keep its session routes. Owned (ADR-0030): the project comes
 * from the console scope; the stage spine and session replay are the env flags.
 */
export default async function TaskPage({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string }>;
}) {
  if (!stageSpineEnabled()) notFound();
  if (!isDbConfigured()) return <TasksNoDatabase />;
  const { projectId, taskId } = await params;
  const { project, organization } = await requireProjectScope(projectId);
  const [inputs, fixes] = await Promise.all([
    loadTasksInputs(project.id),
    loadTaskFixes(project.id, organization),
  ]);
  const task = buildTaskDetail(inputs, taskId, { fixes });
  const listHref = topLevelTasksHref(project.id);
  if (!task)
    return (
      <TaskGone
        projectId={project.id}
        known={taskNames(inputs.stored, inputs.labels, inputs.names).size > 0}
        reading={inputs.run !== null}
        listHref={listHref}
      />
    );
  const [evalGate, sessionReplay] = await Promise.all([
    evalGateEnabledFor(organization),
    sessionReplayEnabled(),
  ]);
  const examples = await loadTaskExamples(project.id, task, {}, inputs.names);
  const testRuns = evalGate
    ? (await taskEvalSetFor(project.id, taskId)).cases
        .filter((row) => row.fixId === null && row.excludedAt === null)
        .map((row) => row.turnId)
    : undefined;
  const now = new Date();
  return (
    <TaskView
      projectId={project.id}
      task={task}
      examples={examples}
      testRuns={testRuns}
      sessionReplay={sessionReplay}
      now={now}
      listHref={listHref}
      scoring={
        evalGate ? (
          <>
            <TaskScoring
              projectId={project.id}
              taskId={taskId}
              today={now.toISOString().slice(0, 10)}
            />
            <TaskEvals projectId={project.id} taskId={taskId} />
            <Section
              title="Simulations"
              description="Test fixes on this task's past runs."
              actions={
                <Link
                  href={`${topLevelTasksHref(project.id, taskId)}/simulations`}
                  className={buttonVariants({ variant: "secondary" })}
                >
                  Open simulations
                </Link>
              }
            >
              <p className="text-ui text-fg-muted">
                Edit a fix, add tests, and compare each scorer before and after.
              </p>
            </Section>
          </>
        ) : null
      }
    />
  );
}
