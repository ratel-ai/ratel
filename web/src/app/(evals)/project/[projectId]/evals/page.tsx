import { notFound, redirect } from "next/navigation";
import { SuiteView } from "@/components/console/evals/SuiteView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { composition } from "@/lib/composition/ports";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { createDrizzleCaseStore } from "@/lib/views/evals/adapters/drizzle-case-store";
import { createDrizzleEvalStore } from "@/lib/views/evals/adapters/drizzle-eval-store";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { loadRuns } from "@/lib/views/evals/page-loads";
import { readyVersions } from "@/lib/views/evals/page-model";
import { suitePageModel } from "@/lib/views/evals/suite-page";
import { listSandboxVersions } from "@/lib/views/sandboxes";

export const dynamic = "force-dynamic";
export const metadata = { title: "Evals" };

const VERSIONS = 50;

/** The suite table: each eval with the score of a run (`?run=`, else the newest) and its delta. */
export default async function EvalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ run?: string | string[] }>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
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
  const runId = Array.isArray(query.run) ? (query.run[0] ?? null) : (query.run ?? null);
  const [evals, cases, loaded, versions] = await withFeatureSpan(
    "evals",
    "load_page",
    () => {
      const db = getDb();
      return Promise.all([
        createDrizzleEvalStore(db).list(project.id),
        createDrizzleCaseStore(db).list(project.id),
        loadRuns(project.id, runId),
        listSandboxVersions(project.id, VERSIONS),
      ]);
    },
    { attributes: { "project.id": project.id } },
  );
  const model = suitePageModel({ projectId: project.id, evals, cases, ...loaded });
  const pinned = loaded.pin?.experimentId ?? null;
  const JudgeSettings = (await composition.ui?.())?.EvalJudgeSettings;
  return (
    <SuiteView
      model={model}
      canEdit={!(await isRestrictedBySupportSession())}
      versions={readyVersions(versions)}
      experiments={loaded.runs}
      baseline={pinned === null ? "none" : pinned === model.runId ? "this" : "other"}
      now={new Date().toISOString()}
    >
      {JudgeSettings ? <JudgeSettings projectId={project.id} /> : null}
    </SuiteView>
  );
}
