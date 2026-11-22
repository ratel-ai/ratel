import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { Callout } from "@ratel/design-system/states";
import { notFound, redirect } from "next/navigation";
import { RunTableView } from "@/components/console/evals/RunTableView";
import { SimulationActions } from "@/components/console/evals/SimulationActions";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { fixIdFromSegment } from "@/lib/views/eval-gate/view";
import { loadSimulationPage } from "@/lib/views/evals/fix-page";
import { fixPageHref, fixSimulationHref } from "@/lib/views/evals/paths";
import { parseRunFilter, simulationLineText } from "@/lib/views/evals/view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Simulation" };

/** One simulation of a fix as the run table compared with today (RC-294, E4). The filter is `?show=failing|changed`. */
export default async function FixSimulationRoute({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; fixId: string; runId: string }>;
  searchParams: Promise<{ show?: string | string[] }>;
}) {
  if (!isDbConfigured()) notFound();
  const context = await getSessionContext();
  if (!context) redirect("/");
  const [{ projectId, fixId: segment, runId }, query] = await Promise.all([params, searchParams]);
  const fixId = fixIdFromSegment(segment);
  const { project } = await getProjectScope(projectId, context.user.id);
  const filter = parseRunFilter(query.show);
  const model = await loadSimulationPage(project.id, context.user.externalId, fixId, runId, filter);
  if (!model) notFound();
  const { run, tally } = model;
  const text = simulationLineText(tally);
  return (
    <Page>
      <PageHeader
        crumbs={[{ label: model.fix.title, href: fixPageHref(project.id, model.fix.id) }]}
        title={model.suite}
        actions={
          <SimulationActions
            projectId={project.id}
            fixId={model.fix.id}
            suite={run.suite}
            evalIds={model.evalIds}
            addable={model.addable}
          />
        }
      />
      <PageBody wide>
        {run.status === "queued" ? (
          <Callout title="Queued">
            The simulation starts within a minute. This page shows its results when it finishes.
          </Callout>
        ) : run.status === "running" ? (
          <Callout title="Running">{`Replaying ${run.evalCount} ${run.evalCount === 1 ? "eval" : "evals"} without and with the fix. Reload to see the results.`}</Callout>
        ) : run.status === "failed" ? (
          <Callout tone="danger" title="The simulation failed">
            {run.error ?? "Run it again to retry."}
          </Callout>
        ) : (
          <>
            <p className="text-ui text-fg-muted">
              <span className="font-semibold text-fg">
                {tally.passed} of {tally.total} pass with the fix
              </span>{" "}
              · {text.today}
              {tally.fixed > 0 ? (
                <>
                  {" "}
                  · <span className="text-success">{tally.fixed} fixed</span>
                </>
              ) : null}
              {tally.broke > 0 ? (
                <>
                  {" "}
                  · <span className="text-danger">{tally.broke} broke</span>
                </>
              ) : null}
              {tally.unverified > 0 ? (
                <>
                  {" "}
                  · <span className="text-warning">{tally.unverified} unverified</span>
                </>
              ) : null}
            </p>
            <RunTableView
              projectId={project.id}
              runId={run.id}
              table={model.table}
              filter={filter}
              rowBase={fixSimulationHref(project.id, model.fix.id, run.id)}
            />
          </>
        )}
      </PageBody>
    </Page>
  );
}
