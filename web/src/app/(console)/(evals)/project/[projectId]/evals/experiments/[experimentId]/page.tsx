import { notFound, redirect } from "next/navigation";
import { ExperimentView } from "@/components/console/evals/ExperimentView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { createDrizzleExperimentStore } from "@/lib/views/evals/adapters/drizzle-experiment-store";
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
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Evals">
        Evals become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  if (!(await getSessionContext())) redirect("/");
  const { project } = await getProjectScope(projectId);
  const model = await withFeatureSpan(
    "evals",
    "load_experiment",
    async () => {
      const store = createDrizzleExperimentStore(getDb());
      const found = UUID.test(experimentId) ? await store.get(project.id, experimentId) : null;
      return found && experimentPageModel(found, await store.trials(found.id));
    },
    { attributes: { "project.id": project.id } },
  );
  if (!model) notFound();
  return <ExperimentView model={model} now={new Date().toISOString()} />;
}
