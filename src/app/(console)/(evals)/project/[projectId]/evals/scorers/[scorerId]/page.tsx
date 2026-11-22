import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { notFound, redirect } from "next/navigation";
import { ScorerChart } from "@/components/console/scorers/ScorerChart";
import { ScorerEditor } from "@/components/console/scorers/ScorerEditor";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { evalGateEnabledFor } from "@/lib/views/eval-gate/gate";
import { evalsHref } from "@/lib/views/evals/paths";
import { scorerDetail } from "@/lib/views/scorers/page";
import { lastDays } from "@/lib/views/scorers/view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Scorer" };

/** RC-615: one suite scorer, the only place it is edited, with its per-day chart. 404 unless `cloud-eval-gate` is on. */
export default async function SuiteScorerPage({
  params,
}: {
  params: Promise<{ projectId: string; scorerId: string }>;
}) {
  if (!isDbConfigured()) notFound();
  const context = await getSessionContext();
  if (!context) redirect("/");
  const { projectId, scorerId } = await params;
  const { project, organization } = await getProjectScope(projectId, context.user.id);
  if (!(await evalGateEnabledFor(organization))) notFound();
  const detail = await scorerDetail(project.id, decodeURIComponent(scorerId), null);
  if (!detail || detail.kind !== "own") notFound();
  const back = evalsHref(project.id);
  return (
    <Page>
      <PageHeader
        title={detail.scorer.name}
        crumbs={[
          { label: "Evals", href: back },
          { label: "Suite scorers", href: back },
        ]}
        description="A suite scorer: every eval reads it unless the eval switches it off."
      />
      <PageBody>
        <div className="flex flex-col gap-8">
          <ScorerEditor projectId={project.id} scorer={detail.scorer} backHref={back} />
          <ScorerChart
            rates={detail.rates}
            days={lastDays(new Date().toISOString().slice(0, 10))}
          />
        </div>
      </PageBody>
    </Page>
  );
}
