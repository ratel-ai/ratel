import { notFound, redirect } from "next/navigation";
import { EvalsView } from "@/components/console/evals/EvalsView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { composition } from "@/lib/composition/ports";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { createDrizzleBaselineStore } from "@/lib/views/evals/adapters/drizzle-baseline-store";
import { createDrizzleCaseStore } from "@/lib/views/evals/adapters/drizzle-case-store";
import { createDrizzleExperimentStore } from "@/lib/views/evals/adapters/drizzle-experiment-store";
import { emptyCounts } from "@/lib/views/evals/domain/experiment";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { caseRow, experimentRow, readyVersions } from "@/lib/views/evals/page-model";
import { listSandboxVersions } from "@/lib/views/sandboxes";

export const dynamic = "force-dynamic";
export const metadata = { title: "Evals" };

const EXPERIMENTS = 20;
const VERSIONS = 50;

/** The project's eval cases and experiments (the `evals` flag). */
export default async function EvalsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
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
  const [cases, experiments, versions, baseline] = await withFeatureSpan(
    "evals",
    "load_page",
    async () => {
      const db = getDb();
      const store = createDrizzleExperimentStore(db);
      const experimentRows = async () => {
        const rows = await store.list(project.id, EXPERIMENTS);
        const counts = await store.counts(rows.map(({ id }) => id));
        return rows.map((row) => experimentRow(row, counts.get(row.id) ?? emptyCounts()));
      };
      return Promise.all([
        createDrizzleCaseStore(db).list(project.id),
        experimentRows(),
        listSandboxVersions(project.id, VERSIONS),
        createDrizzleBaselineStore(db).get(project.id),
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
      experiments={experiments}
      baselineId={baseline?.experimentId ?? null}
      versions={readyVersions(versions)}
      now={new Date().toISOString()}
    >
      {JudgeSettings ? <JudgeSettings projectId={project.id} /> : null}
    </EvalsView>
  );
}
