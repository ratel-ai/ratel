import { notFound, redirect } from "next/navigation";
import { ExperimentView } from "@/components/console/evals/ExperimentView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { createDrizzleBaselineStore } from "@/lib/views/evals/adapters/drizzle-baseline-store";
import { createDrizzleExperimentStore } from "@/lib/views/evals/adapters/drizzle-experiment-store";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { experimentPageModel } from "@/lib/views/evals/page-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Experiment" };

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** One experiment and its trials. */
export default async function ExperimentPage({
  params,
}: {
  params: Promise<{ projectId: string; experimentId: string }>;
}) {
  const { projectId, experimentId } = await params;
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
  const loaded = await withFeatureSpan(
    "evals",
    "load_experiment",
    async () => {
      const db = getDb();
      const store = createDrizzleExperimentStore(db);
      const found = UUID.test(experimentId) ? await store.get(project.id, experimentId) : null;
      if (!found) return null;
      const [trials, baseline] = await Promise.all([
        store.trials(found.id),
        createDrizzleBaselineStore(db).get(project.id),
      ]);
      return { model: experimentPageModel(found, trials), baseline };
    },
    { attributes: { "project.id": project.id } },
  );
  if (!loaded) notFound();
  const { model, baseline } = loaded;
  const pinned = baseline?.experimentId === model.id ? "this" : "other";
  return (
    <ExperimentView
      model={model}
      baseline={baseline ? pinned : "none"}
      canEdit={!(await isRestrictedBySupportSession())}
      now={new Date().toISOString()}
    />
  );
}
