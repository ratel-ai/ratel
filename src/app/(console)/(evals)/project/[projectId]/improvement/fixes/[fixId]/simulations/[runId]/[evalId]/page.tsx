import { StatusDot } from "@ratel/design-system/badge";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { NavLink } from "@/components/console/evals/EvalHeader";
import { CompareTestView } from "@/components/console/evals/SingleTestView";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { fixIdFromSegment } from "@/lib/views/eval-gate/view";
import type { SimulationOutcome } from "@/lib/views/evals/domain/simulation";
import { loadFixTestPage } from "@/lib/views/evals/fix-page";
import { fixPageHref, fixSimulationHref, fixTestHref } from "@/lib/views/evals/paths";

export const dynamic = "force-dynamic";
export const metadata = { title: "Simulated eval" };

const OUTCOME: Record<
  SimulationOutcome,
  { tone: "success" | "danger" | "warning" | "neutral"; label: string }
> = {
  fixed: { tone: "success", label: "Fixed by this change" },
  broke: { tone: "danger", label: "Broken by this change" },
  unverified: { tone: "warning", label: "Unverified: a simulated answer" },
  same: { tone: "neutral", label: "Same as today" },
};

/** One eval of a fix's simulation (RC-294, F2): the two replays side by side, or one when the fix does not touch it. */
export default async function FixTestRoute({
  params,
}: {
  params: Promise<{ projectId: string; fixId: string; runId: string; evalId: string }>;
}) {
  if (!isDbConfigured()) notFound();
  const context = await getSessionContext();
  if (!context) redirect("/");
  const { projectId, fixId: segment, runId, evalId } = await params;
  const fixId = fixIdFromSegment(segment);
  const { project } = await getProjectScope(projectId, context.user.id);
  const model = await loadFixTestPage(project.id, context.user.externalId, fixId, runId, evalId);
  if (!model) notFound();
  const { fix, run, position, outcome } = model;
  const status = outcome ? OUTCOME[outcome] : { tone: "warning" as const, label: "Could not run" };
  return (
    <Page>
      <PageHeader
        crumbs={[
          { label: "Fix", href: fixPageHref(project.id, fix.id) },
          { label: model.suite, href: fixSimulationHref(project.id, fix.id, run.id) },
        ]}
        title={model.item.name}
        actions={
          <>
            <StatusDot tone={status.tone} label={status.label} />
            {position ? (
              <span className="flex items-center gap-1">
                <span className="text-ui text-fg-muted tabular-nums">
                  {position.index} of {position.total}
                </span>
                <NavLink
                  href={
                    position.prev ? fixTestHref(project.id, fix.id, run.id, position.prev) : null
                  }
                  label="Previous eval"
                >
                  <ArrowLeft />
                </NavLink>
                <NavLink
                  href={
                    position.next ? fixTestHref(project.id, fix.id, run.id, position.next) : null
                  }
                  label="Next eval"
                >
                  <ArrowRight />
                </NavLink>
              </span>
            ) : null}
          </>
        }
      />
      <PageBody wide>
        <CompareTestView
          item={model.item}
          tasks={model.tasks}
          rules={model.rules}
          before={model.before}
          after={model.after}
          replayHref={model.replayHref}
        />
      </PageBody>
    </Page>
  );
}
