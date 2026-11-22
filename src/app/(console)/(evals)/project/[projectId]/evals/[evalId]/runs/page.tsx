import { Page, PageBody } from "@ratel/design-system/page-header";
import { notFound, redirect } from "next/navigation";
import { EvalHeader } from "@/components/console/evals/EvalHeader";
import { EvalRunsTable } from "@/components/console/evals/EvalRunsTable";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { loadEvalRunsPage } from "@/lib/views/evals/page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Eval runs" };

/** One eval's runs (RC-292, D2). */
export default async function EvalRunsTabPage({
  params,
}: {
  params: Promise<{ projectId: string; evalId: string }>;
}) {
  if (!isDbConfigured()) notFound();
  const context = await getSessionContext();
  if (!context) redirect("/");
  const { projectId, evalId } = await params;
  const { project } = await getProjectScope(projectId, context.user.id);
  const model = await loadEvalRunsPage(project.id, context.user.externalId, evalId);
  if (!model) notFound();
  return (
    <Page>
      <EvalHeader
        projectId={project.id}
        evalId={model.item.id}
        name={model.item.name}
        runCount={model.runCount}
      />
      <PageBody wide>
        <EvalRunsTable projectId={project.id} evalId={model.item.id} rows={model.history} />
      </PageBody>
    </Page>
  );
}
