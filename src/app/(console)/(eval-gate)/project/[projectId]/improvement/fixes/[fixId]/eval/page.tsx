import { notFound } from "next/navigation";
import { EvalGatePage } from "@/components/console/eval-gate/EvalGatePage";
import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { evalGateEnabledFor } from "@/lib/views/eval-gate/gate";
import { loadEvalGatePage } from "@/lib/views/eval-gate/page-model";
import { loadFixContext } from "@/lib/views/eval-gate/service";
import { fixIdFromSegment } from "@/lib/views/eval-gate/view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Eval gate" };

/**
 * One fix's eval gate (RC-46): the project's runs it is simulated on, what
 * each should do, and before and after. Behind `FF_EVAL_GATE`; off, the page
 * does not exist. Owned (ADR-0030): the project comes from the console scope.
 */
export default async function FixEvalRoute({
  params,
}: {
  params: Promise<{ projectId: string; fixId: string }>;
}) {
  if (!isDbConfigured()) notFound();
  const { projectId, fixId: segment } = await params;
  const { project, organization, user } = await requireProjectScope(projectId);
  if (!(await evalGateEnabledFor(organization))) notFound();
  const fixId = fixIdFromSegment(segment);
  if (!/^(rewrite|craft|issue|intent):\S{1,200}$/.test(fixId)) notFound();
  const fix = await loadFixContext(project.id, fixId);
  const model = await loadEvalGatePage(
    project.id,
    fixId,
    fix?.fix ?? null,
    undefined,
    user.externalId,
  );
  if (!fix && !model.set) notFound();
  return <EvalGatePage model={model} />;
}
