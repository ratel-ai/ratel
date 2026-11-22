import { Page, PageBody } from "@ratel/design-system/page-header";
import { notFound, redirect } from "next/navigation";
import { EvalsHeader } from "@/components/console/evals/EvalsHeader";
import { NightlyToggle } from "@/components/console/evals/NightlyToggle";
import { RunsList } from "@/components/console/evals/RunsList";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import {
  loadNightlySetting,
  NIGHTLY_EVAL_BUDGET_USD,
  nightlyControlFor,
} from "@/lib/views/evals/nightly";
import { loadRunsPage } from "@/lib/views/evals/page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Eval runs" };

/** The Runs tab (RC-291, C5): every run of the suite, newest first, and the nightly toggle for admins on paid plans (RC-299). */
export default async function EvalRunsPage({ params }: { params: Promise<{ projectId: string }> }) {
  if (!isDbConfigured()) notFound();
  const context = await getSessionContext();
  if (!context) redirect("/");
  const { projectId } = await params;
  const { project, organization, role } = await getProjectScope(projectId, context.user.id);
  const model = await loadRunsPage(project.id, context.user.externalId);
  if (!model) notFound();
  const nightly = nightlyControlFor(role, organization, await loadNightlySetting(project.id));
  return (
    <Page>
      <EvalsHeader
        projectId={project.id}
        evalCount={model.evalCount}
        runCount={model.runs.length}
      />
      <PageBody wide>
        <NightlyToggle projectId={project.id} control={nightly} capUsd={NIGHTLY_EVAL_BUDGET_USD} />
        <RunsList projectId={project.id} rows={model.runs} />
      </PageBody>
    </Page>
  );
}
