import { redirect } from "next/navigation";
import { EvalsView } from "@/components/console/evals/EvalsView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { composition } from "@/lib/composition/ports";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { createDrizzleCaseStore } from "@/lib/views/evals/adapters/drizzle-case-store";
import { createDrizzleExperimentStore } from "@/lib/views/evals/adapters/drizzle-experiment-store";
import { caseRow, experimentRow, readyVersions } from "@/lib/views/evals/page-model";
import { listSandboxVersions, sandboxesEnabledForProject } from "@/lib/views/sandboxes";

export const dynamic = "force-dynamic";
export const metadata = { title: "Evals" };

const EXPERIMENTS = 20;
const VERSIONS = 50;

/** The project's eval cases and experiments (the `evals` flag). */
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
  const [cases, experiments, versions] = await withFeatureSpan(
    "evals",
    "load_page",
    async () => {
      const db = getDb();
      return Promise.all([
        createDrizzleCaseStore(db).list(project.id),
        createDrizzleExperimentStore(db).list(project.id, EXPERIMENTS),
        (await sandboxesEnabledForProject(project.id))
          ? listSandboxVersions(project.id, VERSIONS)
          : [],
      ]);
    },
    { attributes: { "project.id": project.id } },
  );
  const JudgeSettings = (await composition.ui?.())?.EvalJudgeSettings;
  return (
    <EvalsView
      projectId={project.id}
      canEdit={!(await isRestrictedBySupportSession())}
      cases={cases.map(caseRow)}
      experiments={experiments.map(experimentRow)}
      versions={readyVersions(versions)}
      now={new Date().toISOString()}
    >
      {JudgeSettings ? <JudgeSettings projectId={project.id} /> : null}
    </EvalsView>
  );
}
