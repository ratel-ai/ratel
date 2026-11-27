import { notFound, redirect } from "next/navigation";
import { EvalView } from "@/components/console/evals/EvalView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { createDrizzleCaseStore } from "@/lib/views/evals/adapters/drizzle-case-store";
import { createDrizzleEvalStore } from "@/lib/views/evals/adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "@/lib/views/evals/adapters/drizzle-experiment-store";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { loadRuns } from "@/lib/views/evals/page-loads";
import { PREVIEW_CHARS } from "@/lib/views/evals/page-model";
import { evalPageModel } from "@/lib/views/evals/suite-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Eval" };

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** One eval: its definition and its dataset, with what a run (`?run=`, else the newest) did. */
export default async function EvalPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; evalId: string }>;
  searchParams: Promise<{ run?: string | string[] }>;
}) {
  const [{ projectId, evalId }, query] = await Promise.all([params, searchParams]);
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
  const loaded = await withFeatureSpan(
    "evals",
    "load_eval",
    async () => {
      const db = getDb();
      const definition = UUID.test(evalId)
        ? await createDrizzleEvalStore(db).get(project.id, evalId)
        : null;
      if (!definition) return null;
      const [cases, runs] = await Promise.all([
        createDrizzleCaseStore(db).list(project.id, definition.id),
        loadRuns(project.id, runId),
      ]);
      // One more character than the grid shows, so a cut output gets its "…".
      const outputs = runs.run
        ? await createDrizzleExperimentStore(db).outputPreviews(
            runs.run.experiment.id,
            PREVIEW_CHARS + 1,
          )
        : new Map<string, string>();
      return evalPageModel({
        projectId: project.id,
        definition,
        cases,
        run: runs.run,
        baseline: runs.baseline,
        outputs,
      });
    },
    { attributes: { "project.id": project.id } },
  );
  if (!loaded) notFound();
  return (
    <EvalView
      key={loaded.version.id}
      model={loaded}
      canEdit={!(await isRestrictedBySupportSession())}
    />
  );
}
