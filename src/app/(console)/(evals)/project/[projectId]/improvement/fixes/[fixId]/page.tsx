import { Badge } from "@ratel/design-system/badge";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { ArrowRight } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { FixSimulations } from "@/components/console/evals/FixSimulations";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { fixIdFromSegment } from "@/lib/views/eval-gate/view";
import { loadFixPage } from "@/lib/views/evals/fix-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Fix" };

const FIX_ID = /^(rewrite|craft|issue|intent):\S{1,200}$/;

/**
 * One fix (RC-294, E1): what it changes, its evidence, and one line per
 * simulation of the suite with it. Behind `cloud-eval-gate`; off, the page
 * does not exist.
 */
export default async function FixRoute({
  params,
}: {
  params: Promise<{ projectId: string; fixId: string }>;
}) {
  if (!isDbConfigured()) notFound();
  const context = await getSessionContext();
  if (!context) redirect("/");
  const { projectId, fixId: segment } = await params;
  const fixId = fixIdFromSegment(segment);
  if (!FIX_ID.test(fixId)) notFound();
  const { project } = await getProjectScope(projectId, context.user.id);
  const model = await loadFixPage(project.id, context.user.externalId, fixId);
  if (!model) notFound();
  const { fix } = model;
  return (
    <Page>
      <PageHeader
        crumbs={[
          { label: "Fixes", href: `/project/${encodeURIComponent(project.id)}/improvement/fixes` },
        ]}
        title={fix.title}
      />
      <PageBody wide>
        <section className="flex flex-col gap-2" aria-label="What the fix changes">
          <span>
            <Badge>{fix.kindLabel}</Badge>
          </span>
          {fix.tools.length > 0 ? (
            <p className="flex flex-wrap items-center gap-1.5">
              {fix.tools.map((tool) => (
                <code
                  key={tool}
                  className="rounded-md border border-line px-1.5 py-0.5 font-mono text-ui text-fg"
                >
                  {tool}
                </code>
              ))}
              {fix.becomes.length > 0 ? (
                <>
                  <ArrowRight className="size-3.5 text-fg-subtle" aria-label="becomes" />
                  {fix.becomes.map((tool) => (
                    <code
                      key={tool}
                      className="rounded-md border border-success/50 px-1.5 py-0.5 font-mono text-ui text-success"
                    >
                      {tool}
                    </code>
                  ))}
                </>
              ) : null}
            </p>
          ) : null}
          {fix.changes.length > 0 ? (
            <ul className="list-disc pl-5 text-ui text-fg">
              {fix.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          ) : null}
          <p className="text-ui text-fg-muted">{fix.why}</p>
        </section>
        <FixSimulations
          projectId={project.id}
          fixId={fix.id}
          lines={model.lines}
          menu={model.menu}
        />
      </PageBody>
    </Page>
  );
}
