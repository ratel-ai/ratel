import { Page, PageBody } from "@ratel/design-system/page-header";
import { notFound, redirect } from "next/navigation";
import { EvalDefinition } from "@/components/console/evals/EvalDefinition";
import { EvalHeader } from "@/components/console/evals/EvalHeader";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { loadEvalDefinition } from "@/lib/views/evals/page";
import { loadRunSettingsModel } from "@/lib/views/evals/run-settings";
import { evalScorerSwitches } from "@/lib/views/scorers/page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Eval definition" };

/** What one eval is (RC-292, D3): no results on this tab. */
export default async function EvalDefinitionPage({
  params,
}: {
  params: Promise<{ projectId: string; evalId: string }>;
}) {
  if (!isDbConfigured()) notFound();
  const context = await getSessionContext();
  if (!context) redirect("/");
  const { projectId, evalId } = await params;
  const { project } = await getProjectScope(projectId, context.user.id);
  const model = await loadEvalDefinition(project.id, context.user.externalId, evalId);
  if (!model) notFound();
  const [scorers, runSettings] = await Promise.all([
    evalScorerSwitches(project.id, model.item.id, model.item.tasks),
    loadRunSettingsModel(project.id, model.item),
  ]);
  return (
    <Page>
      <EvalHeader
        projectId={project.id}
        evalId={model.item.id}
        name={model.item.name}
        runCount={model.runCount}
      />
      <PageBody wide>
        <EvalDefinition
          item={model.item}
          tasks={model.tasks}
          rules={model.rules}
          scorers={scorers}
          runSettings={runSettings}
        />
      </PageBody>
    </Page>
  );
}
