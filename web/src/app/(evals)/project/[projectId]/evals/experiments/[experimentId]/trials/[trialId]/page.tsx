import { notFound, redirect } from "next/navigation";
import { TrialView } from "@/components/console/evals/TrialView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { createDrizzleBaselineStore } from "@/lib/views/evals/adapters/drizzle-baseline-store";
import { createDrizzleExperimentStore } from "@/lib/views/evals/adapters/drizzle-experiment-store";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { runWithBaseline } from "@/lib/views/evals/history-load";
import { pairedTrial } from "@/lib/views/evals/suite-view";
import { trialPageModel } from "@/lib/views/evals/trial-page";
import { loadTrialViews } from "@/lib/views/evals/trial-views";

export const dynamic = "force-dynamic";
export const metadata = { title: "Eval trial" };

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** One trial of a run next to the trial of the same row in the pinned baseline. */
export default async function TrialPage({
  params,
}: {
  params: Promise<{ projectId: string; experimentId: string; trialId: string }>;
}) {
  const { projectId, experimentId, trialId } = await params;
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
  if (!UUID.test(experimentId) || !UUID.test(trialId)) notFound();
  const loaded = await withFeatureSpan(
    "evals",
    "load_trial",
    async () => {
      const db = getDb();
      const found = await runWithBaseline(project.id, experimentId, {
        experiments: createDrizzleExperimentStore(db),
        baselines: createDrizzleBaselineStore(db),
      });
      if (!found) return null;
      const { run, baseline } = found;
      const paired = pairedTrial(run, baseline, trialId);
      if (!paired) return null;
      const tracesHref = `/project/${project.id}/traces`;
      const [views, baselineViews] = await Promise.all([
        loadTrialViews(project.id, paired.trial.traceId, tracesHref),
        paired.baselineTrial
          ? loadTrialViews(project.id, paired.baselineTrial.traceId, tracesHref)
          : null,
      ]);
      return {
        model: trialPageModel(
          project.id,
          paired,
          run.experiment.id,
          run.experiment.evalVersions[0]?.name ?? null,
        ),
        views,
        baselineViews,
      };
    },
    { attributes: { "project.id": project.id } },
  );
  if (!loaded) notFound();
  return <TrialView {...loaded} />;
}
