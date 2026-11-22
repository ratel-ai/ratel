import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { notFound, redirect } from "next/navigation";
import { ScoreChart } from "@/app/(console)/(stage-spine)/project/[projectId]/tasks/[taskId]/ScoreChart";
import { ScorerForm } from "@/app/(console)/(stage-spine)/project/[projectId]/tasks/[taskId]/Scorers";
import { ScorerChart } from "@/components/console/scorers/ScorerChart";
import { ScorerEditor } from "@/components/console/scorers/ScorerEditor";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { evalGateEnabledFor } from "@/lib/views/eval-gate/gate";
import { taskTag } from "@/lib/views/evals/domain/task-name";
import { taskNames } from "@/lib/views/evals/page";
import { scorerDetail } from "@/lib/views/scorers/page";
import { lastDays } from "@/lib/views/scorers/view";
import { SCORER_LABELS } from "@/lib/views/task-scorers/labels";
import { dailyScoresFor } from "@/lib/views/task-scorers/store";
import { topLevelTasksHref } from "@/lib/views/tasks/paths";

export const dynamic = "force-dynamic";
export const metadata = { title: "Scorer" };

/** RC-615: one task scorer, the only place it is edited, with its per-day chart. 404 unless `cloud-eval-gate` is on. */
export default async function TaskScorerPage({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string; scorerId: string }>;
}) {
  if (!isDbConfigured()) notFound();
  const context = await getSessionContext();
  if (!context) redirect("/");
  const { projectId, taskId: rawTask, scorerId: rawScorer } = await params;
  const taskId = decodeURIComponent(rawTask);
  const scorerId = decodeURIComponent(rawScorer);
  const { project, organization } = await getProjectScope(projectId, context.user.id);
  if (!(await evalGateEnabledFor(organization))) notFound();
  const detail = await scorerDetail(project.id, scorerId, taskId);
  if (!detail) notFound();
  const taskHref = topLevelTasksHref(project.id, taskId);
  const today = new Date().toISOString().slice(0, 10);
  // RC-658: the crumb names the task, not "Task" (UX audit RC-656, 2.7).
  const taskLabel = taskTag(taskId, await taskNames(project.id, [taskId])).label;
  const crumbs = [
    { label: "Tasks", href: topLevelTasksHref(project.id) },
    { label: taskLabel, href: taskHref },
  ];
  if (detail.kind === "built-in") {
    const rows = await dailyScoresFor(project.id, taskId);
    return (
      <Page>
        <PageHeader
          title={SCORER_LABELS[detail.scorer.kind]}
          crumbs={crumbs}
          description="A built-in scorer of this task."
        />
        <PageBody>
          <div className="flex flex-col gap-8">
            <ScorerForm
              projectId={project.id}
              taskId={taskId}
              kind={detail.scorer.kind}
              scorer={detail.scorer}
            />
            <ScoreChart
              rows={rows}
              today={today}
              projectId={project.id}
              scorer={detail.scorer.kind}
            />
          </div>
        </PageBody>
      </Page>
    );
  }
  return (
    <Page>
      <PageHeader title={detail.scorer.name} crumbs={crumbs} description="A scorer of this task." />
      <PageBody>
        <div className="flex flex-col gap-8">
          <ScorerEditor projectId={project.id} scorer={detail.scorer} backHref={taskHref} />
          <ScorerChart rates={detail.rates} days={lastDays(today)} />
        </div>
      </PageBody>
    </Page>
  );
}
