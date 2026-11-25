import { redirect } from "next/navigation";
import { EvalCasesView } from "@/components/console/evals/EvalCasesView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { createDrizzleCaseStore } from "@/lib/views/evals/adapters/drizzle-case-store";
import { caseRow } from "@/lib/views/evals/page-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Evals" };

/** The project's eval cases (the `evals` flag). */
export default async function EvalsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Evals">
        Evals become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  if (!(await getSessionContext())) redirect("/");
  const { project } = await getProjectScope(projectId);
  const cases = await withFeatureSpan(
    "evals",
    "load_page",
    () => createDrizzleCaseStore(getDb()).list(project.id),
    { attributes: { "project.id": project.id } },
  );
  return (
    <EvalCasesView
      projectId={project.id}
      canEdit={!(await isRestrictedBySupportSession())}
      cases={cases.map(caseRow)}
      now={new Date().toISOString()}
    />
  );
}
