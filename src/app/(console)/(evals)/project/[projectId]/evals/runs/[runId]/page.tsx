import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { notFound, redirect } from "next/navigation";
import { RUN_KIND_LABELS } from "@/components/console/evals/marks";
import { RunHeadline } from "@/components/console/evals/RunHeadline";
import { RunTableView } from "@/components/console/evals/RunTableView";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { loadRunPage } from "@/lib/views/evals/page";
import { evalsHref } from "@/lib/views/evals/paths";
import { parseRunFilter } from "@/lib/views/evals/view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Eval run" };

/** One run as a table (RC-291, C6). The filter is `?show=failing|changed`. */
export default async function EvalRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; runId: string }>;
  searchParams: Promise<{ show?: string | string[] }>;
}) {
  if (!isDbConfigured()) notFound();
  const context = await getSessionContext();
  if (!context) redirect("/");
  const [{ projectId, runId }, query] = await Promise.all([params, searchParams]);
  const { project } = await getProjectScope(projectId, context.user.id);
  const filter = parseRunFilter(query.show);
  const model = await loadRunPage(project.id, context.user.externalId, runId, filter);
  if (!model) notFound();
  return (
    <Page>
      <PageHeader
        crumbs={[
          { label: "Evals", href: evalsHref(project.id) },
          { label: "Runs", href: evalsHref(project.id, { tab: "runs" }) },
        ]}
        title={`${RUN_KIND_LABELS[model.run.kind]} · ${model.run.createdAt.toISOString().slice(0, 16).replace("T", " ")}`}
        actions={
          <span className="text-ui text-fg-muted">
            {model.run.kind === "simulation" ? `Fix ${model.run.fixId}` : "Agent as recorded"}
          </span>
        }
      />
      <PageBody wide>
        <RunHeadline run={model.run} summary={model.summary} previous={model.previous} />
        {model.run.status === "completed" ? (
          <RunTableView
            projectId={project.id}
            runId={model.run.id}
            table={model.table}
            filter={filter}
          />
        ) : null}
      </PageBody>
    </Page>
  );
}
