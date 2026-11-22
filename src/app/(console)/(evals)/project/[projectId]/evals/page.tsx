import { Disclosure } from "@ratel/design-system/disclosure";
import { Page, PageBody } from "@ratel/design-system/page-header";
import { Section } from "@ratel/design-system/section";
import { notFound, redirect } from "next/navigation";
import { DefinitionsTable } from "@/components/console/evals/DefinitionsTable";
import { EvalsHeader } from "@/components/console/evals/EvalsHeader";
import { RunSettingsForm } from "@/components/console/evals/RunSettingsForm";
import { StatusFilter } from "@/components/console/evals/StatusFilter";
import { TaskFilter } from "@/components/console/evals/TaskFilter";
import { ScorerList } from "@/components/console/scorers/ScorerList";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { RUN_SETTING_LABELS } from "@/lib/views/evals/domain/run-settings";
import { loadEvalsPage } from "@/lib/views/evals/page";
import { parseEvalStatusFilter } from "@/lib/views/evals/paths";
import { loadRunSettingsModel, type RunSettingsModel } from "@/lib/views/evals/run-settings";
import { suiteScorerList } from "@/lib/views/scorers/page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Evals" };

/** The suite (RC-291, C1/C4): the Evals tab. 404 unless `cloud-eval-gate` is on. */
export default async function EvalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ task?: string | string[]; status?: string | string[] }>;
}) {
  if (!isDbConfigured()) notFound();
  const context = await getSessionContext();
  if (!context) redirect("/");
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const { project } = await getProjectScope(projectId, context.user.id);
  const task = typeof query.task === "string" && query.task ? query.task : null;
  const status = parseEvalStatusFilter(query.status);
  const model = await loadEvalsPage(project.id, context.user.externalId, task, {}, status);
  if (!model) notFound();
  const suiteScorers = await suiteScorerList(project.id, new Date().toISOString().slice(0, 10));
  const runSettings = await loadRunSettingsModel(project.id, null);
  return (
    <Page>
      <EvalsHeader
        projectId={project.id}
        evalCount={model.evalCount}
        runCount={model.runCount}
        task={task}
      />
      <PageBody wide>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex-1 text-ui text-fg-muted">
              <span className="font-semibold text-fg">
                {model.evalCount} {model.evalCount === 1 ? "eval" : "evals"}
              </span>
              {model.suggestedCount > 0 ? ` (${model.suggestedCount} suggested)` : ""} ·{" "}
              {model.taskCount} {model.taskCount === 1 ? "task" : "tasks"}
            </p>
            <StatusFilter
              value={status}
              task={task}
              total={model.evalCount}
              suggested={model.suggestedCount}
            />
            <TaskFilter tasks={model.tasks} value={task} status={status} />
          </div>
          <DefinitionsTable
            projectId={project.id}
            rows={model.rows}
            filtered={task !== null || status !== null}
          />
        </div>
        <div className="mt-10">
          <Section
            title="Suite settings"
            description="The scorers and run settings every eval starts from. An eval can change them for itself."
          >
            <Disclosure
              title="Suite scorers and run settings"
              hint={suiteSummary(suiteScorers.length, runSettings)}
            >
              <div className="flex flex-col gap-10">
                <ScorerList
                  projectId={project.id}
                  scope="suite"
                  rows={suiteScorers}
                  title="Suite scorers"
                  description="Every eval reads these. An eval can switch one off for itself."
                />
                <RunSettingsForm projectId={project.id} model={runSettings} />
              </div>
            </Disclosure>
          </Section>
        </div>
      </PageBody>
    </Page>
  );
}

/** RC-658: the closed row of Suite settings: the scorer count and each model with its value (UX audit RC-656, 2.1). */
function suiteSummary(scorers: number, settings: RunSettingsModel): string {
  const model = (key: "agentModel" | "toolModel" | "judgeModel") =>
    `${RUN_SETTING_LABELS[key]}: ${settings.own[key] ?? settings.inherited[key] ?? "recorded model"}`;
  return [
    `${scorers} suite ${scorers === 1 ? "scorer" : "scorers"}`,
    model("agentModel"),
    model("toolModel"),
    model("judgeModel"),
  ].join(" · ");
}
