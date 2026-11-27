import { notFound, redirect } from "next/navigation";
import { EvalsOverview } from "@/components/console/evals/EvalsOverview";
import type { DialogSandbox } from "@/components/console/evals/NewEvalDialog";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { composition } from "@/lib/composition/ports";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { createDrizzleBaselineStore } from "@/lib/views/evals/adapters/drizzle-baseline-store";
import { createDrizzleDatasetStore } from "@/lib/views/evals/adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "@/lib/views/evals/adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "@/lib/views/evals/adapters/drizzle-experiment-store";
import { loadPickerOptions } from "@/lib/views/evals/adapters/turn-picker";
import { KIND_LABELS } from "@/lib/views/evals/dataset-pages";
import { evalsPageModel } from "@/lib/views/evals/evals-page";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { loadEvalsOverview } from "@/lib/views/evals/history-load";
import { experimentHref } from "@/lib/views/evals/paths";
import { listScorerLibrary } from "@/lib/views/evals/scorer-library";
import { listSandboxVersions, type SandboxVersionSummary } from "@/lib/views/sandboxes";
import { listScorers } from "@/lib/views/scorers/store";

export const dynamic = "force-dynamic";
export const metadata = { title: "Evals" };

const VERSIONS = 100;

/**
 * The Evals page: a chart of the score of each eval over its runs, and a table of the evals. The
 * old address of a suite run (`?run=`) opens that run; `?new=1` opens the "New eval" dialog.
 */
export default async function EvalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ run?: string | string[]; new?: string | string[] }>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  // Next renders a page next to its layout: the layout's 404 does not stop this data.
  if (!(await evalsEnabledForProject(projectId))) notFound();
  const runId = Array.isArray(query.run) ? query.run[0] : query.run;
  if (runId) redirect(experimentHref(projectId, runId));
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Evals">
        Evals become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  if (!(await getSessionContext())) redirect("/");
  const { project } = await getProjectScope(projectId);
  const canEdit = !(await isRestrictedBySupportSession());
  const loaded = await withFeatureSpan(
    "evals",
    "load_page",
    async () => {
      const db = getDb();
      const evals = createDrizzleEvalStore(db);
      const datasets = createDrizzleDatasetStore(db);
      const [overview, summaries, picker, versions, scorers] = await Promise.all([
        loadEvalsOverview(project.id, {
          evals,
          datasets,
          baselines: createDrizzleBaselineStore(db),
          experiments: createDrizzleExperimentStore(db),
        }),
        datasets.list(project.id),
        loadPickerOptions(project.id, db),
        listSandboxVersions(project.id, VERSIONS),
        listScorerLibrary(project.id, {
          library: { projectScorers: (id) => listScorers(id, db) },
          evals,
        }),
      ]);
      return { overview, summaries, picker, versions, scorers };
    },
    { attributes: { "project.id": project.id } },
  );
  const { overview, summaries, picker, versions, scorers } = loaded;
  const JudgeSettings = (await composition.ui?.())?.EvalJudgeSettings;
  return (
    <EvalsOverview
      model={evalsPageModel({
        projectId: project.id,
        definitions: overview.definitions,
        overview: overview.rows,
      })}
      options={{
        sandboxes: dialogSandboxes(versions),
        datasets: summaries.map(({ id, name, query: { kind } }) => ({
          id,
          name,
          kindLabel: KIND_LABELS[kind],
        })),
        tasks: picker.tasks,
        scorers,
      }}
      canEdit={canEdit}
      openNew={query.new !== undefined}
      now={new Date().toISOString()}
    >
      {JudgeSettings ? <JudgeSettings projectId={project.id} /> : null}
    </EvalsOverview>
  );
}

/** Each sandbox with its ready versions, the newest first; a sandbox with none is left out. */
function dialogSandboxes(versions: readonly SandboxVersionSummary[]): DialogSandbox[] {
  const ready = versions.filter(({ status }) => status === "ready");
  return [...Map.groupBy(ready, ({ name }) => name)].map(([name, ofSandbox]) => ({
    name,
    versions: [...ofSandbox]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(({ id, git, createdAt, params }) => ({
        id,
        commit: git?.commit ?? "",
        createdAt: createdAt.toISOString(),
        params,
      })),
  }));
}
