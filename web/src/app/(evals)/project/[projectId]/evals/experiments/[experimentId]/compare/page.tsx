import { notFound, redirect } from "next/navigation";
import { CompareView } from "@/components/console/evals/CompareView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { createDrizzleExperimentStore } from "@/lib/views/evals/adapters/drizzle-experiment-store";
import { compareWithBaseline } from "@/lib/views/evals/baseline";
import { baselineDeps } from "@/lib/views/evals/baseline-deps";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { compareChoice, comparePageModel, DIFF_CHARS } from "@/lib/views/evals/page-model";

export const dynamic = "force-dynamic";
export const metadata = { title: "Compare experiments" };

const CHOICES = 50;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** One experiment against another: the one in `?baseline=`, else the pinned baseline. */
export default async function ComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; experimentId: string }>;
  searchParams: Promise<{ baseline?: string | string[] }>;
}) {
  const { projectId, experimentId } = await params;
  const asked = (await searchParams).baseline;
  const chosenId = typeof asked === "string" && UUID.test(asked) ? asked : null;
  // Next renders a page next to its layout: the layout's 404 does not stop this data.
  if (!(await evalsEnabledForProject(projectId))) notFound();
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
  const loaded = await withFeatureSpan(
    "evals",
    "load_comparison",
    async () => {
      const deps = baselineDeps();
      const store = createDrizzleExperimentStore(getDb());
      const [result, recent, pin] = await Promise.all([
        compareWithBaseline(project.id, experimentId, deps, chosenId),
        store.list(project.id, CHOICES),
        deps.baselines.get(project.id),
      ]);
      const sides = result.ok
        ? [result.baseline.experiment.id, result.candidate.experiment.id]
        : [];
      const outputs = await Promise.all(sides.map((id) => store.outputPreviews(id, DIFF_CHARS)));
      const choices = recent
        .filter(({ state }) => state === "completed")
        .map((experiment) => compareChoice(experiment, pin?.experimentId ?? null));
      return { result, choices, outputs: new Map(outputs.flatMap((map) => [...map])) };
    },
    { attributes: { "project.id": project.id } },
  );
  const { result, choices, outputs } = loaded;
  if (!result.ok && result.refusal.reason === "not_found") notFound();
  const ids = { projectId: project.id, experimentId };
  const model = comparePageModel(ids, result, session.user.externalId, {
    outputs,
    choices,
    chosenId,
  });
  return <CompareView model={model} now={new Date().toISOString()} />;
}
