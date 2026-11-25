import { notFound, redirect } from "next/navigation";
import { CompareView } from "@/components/console/evals/CompareView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { compareWithBaseline } from "@/lib/views/evals/baseline";
import { baselineDeps } from "@/lib/views/evals/baseline-deps";
import { comparePageModel } from "@/lib/views/evals/page-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compare with baseline" };

/** One experiment against the pinned baseline of its project. */
export default async function ComparePage({
  params,
}: {
  params: Promise<{ projectId: string; experimentId: string }>;
}) {
  const { projectId, experimentId } = await params;
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Evals">
        Evals become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const session = await getSessionContext();
  if (!session) redirect("/");
  const { project } = await getProjectScope(projectId);
  const result = await withFeatureSpan(
    "evals",
    "load_comparison",
    () => compareWithBaseline(project.id, experimentId, baselineDeps()),
    { attributes: { "project.id": project.id } },
  );
  if (!result.ok && result.refusal.reason === "not_found") notFound();
  const ids = { projectId: project.id, experimentId };
  const model = comparePageModel(ids, result, session.user.externalId);
  return <CompareView model={model} now={new Date().toISOString()} />;
}
