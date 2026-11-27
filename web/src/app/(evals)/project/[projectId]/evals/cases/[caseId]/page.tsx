import { notFound, redirect } from "next/navigation";
import { CaseEditor } from "@/components/console/evals/CaseEditor";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { createDrizzleCaseStore } from "@/lib/views/evals/adapters/drizzle-case-store";
import { createDrizzleEvalStore } from "@/lib/views/evals/adapters/drizzle-eval-store";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { caseEditorModel } from "@/lib/views/evals/page-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Eval case" };

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** One case: its draft in the editor, and the approved version. `new` is a case from nothing. */
export default async function EvalCasePage({
  params,
}: {
  params: Promise<{ projectId: string; caseId: string }>;
}) {
  const { projectId, caseId } = await params;
  // Next renders a page next to its layout: the layout's 404 does not stop this data.
  if (!(await evalsEnabledForProject(projectId))) notFound();
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Evals">
        Evals become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  if (!(await getSessionContext())) redirect("/");
  const { project } = await getProjectScope(projectId);
  const [found, evals] = await withFeatureSpan(
    "evals",
    "load_case",
    () =>
      Promise.all([
        UUID.test(caseId) ? createDrizzleCaseStore(getDb()).get(project.id, caseId) : null,
        createDrizzleEvalStore(getDb()).list(project.id),
      ]),
    { attributes: { "project.id": project.id } },
  );
  if (!found && caseId !== "new") notFound();
  const canEdit = !(await isRestrictedBySupportSession());
  const model = caseEditorModel({ projectId: project.id, canEdit }, found, evals);
  // Another draft is another form.
  return <CaseEditor key={model.draft?.id ?? model.approved?.id ?? "new"} model={model} />;
}
