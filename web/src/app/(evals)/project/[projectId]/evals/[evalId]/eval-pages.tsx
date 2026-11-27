import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import { EditEvalForm } from "@/components/console/evals/EditEvalForm";
import { EvalPageView } from "@/components/console/evals/EvalPageView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
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
import { currentVersion } from "@/lib/views/evals/domain/eval";
import { LATEST } from "@/lib/views/evals/eval-dialog";
import { evalPageModel } from "@/lib/views/evals/eval-page";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { oneRun, recentRuns } from "@/lib/views/evals/history-load";
import { evalHistory, withPinnedRuns } from "@/lib/views/evals/history-view";
import { listScorerLibrary } from "@/lib/views/evals/scorer-library";
import { listSandboxVersions } from "@/lib/views/sandboxes";
import { listScorers } from "@/lib/views/scorers/store";

const VERSIONS = 100;

/**
 * The server side of the pages of one eval (the `evals` flag). Each page reads the flag again
 * before it loads data: with the flag off it answers 404 (decision `flag-off-page-status`).
 */
export async function evalPage(projectId: string, evalId: string): Promise<ReactNode> {
  const context = await pageContext(projectId, evalId);
  if ("unavailable" in context) return context.unavailable;
  const { project, canEdit } = context;
  const loaded = await withFeatureSpan(
    "evals",
    "load_eval",
    async () => {
      const db = getDb();
      const evals = createDrizzleEvalStore(db);
      const definition = await evals.get(project.id, evalId);
      if (!definition) return null;
      const experiments = createDrizzleExperimentStore(db);
      const [pin, recent, datasets, picker, versions, scorers] = await Promise.all([
        createDrizzleBaselineStore(db).get(project.id, definition.id),
        recentRuns(project.id, { experiments }),
        createDrizzleDatasetStore(db).list(project.id),
        loadPickerOptions(project.id, db),
        listSandboxVersions(project.id, VERSIONS),
        listScorerLibrary(project.id, {
          library: { projectScorers: (id) => listScorers(id, db) },
          evals,
        }),
      ]);
      const runs = await withPinnedRuns(recent, [pin?.experimentId], (id) =>
        oneRun(project.id, id, { experiments }),
      );
      const baseline = runs.find(({ experiment }) => experiment.id === pin?.experimentId) ?? null;
      return { definition, runs, baseline, datasets, picker, versions, scorers };
    },
    { attributes: { "project.id": project.id } },
  );
  if (!loaded) notFound();
  const { definition, runs, baseline, datasets, picker, versions, scorers } = loaded;
  const version = currentVersion(definition);
  const ofSandbox = versions
    .filter(({ name, status }) => name === version.sandboxName && status === "ready")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return (
    <EvalPageView
      model={evalPageModel({
        projectId: project.id,
        definition,
        history: evalHistory({ definition, runs, baseline }),
        datasets: datasets.map(({ id, name, query }) => ({ id, name, kind: query.kind })),
      })}
      options={{
        defaults: {
          datasetId: version.datasetId,
          versionId: version.sandboxVersionId ?? LATEST,
          params: version.params,
          matrix: version.matrix,
          trials: version.trials,
        },
        versions: ofSandbox.map(({ id, git, params }) => ({
          id,
          commit: git?.commit ?? "",
          params,
        })),
        datasets: datasets.map(({ id, name, query }) => ({
          id,
          name,
          kindLabel: KIND_LABELS[query.kind],
        })),
        turns: picker.turns,
        scorers,
        evalScorers: version.scorers.map(({ name }) => name),
      }}
      canEdit={canEdit}
      now={new Date().toISOString()}
    />
  );
}

export async function editEvalPage(projectId: string, evalId: string): Promise<ReactNode> {
  const context = await pageContext(projectId, evalId);
  if ("unavailable" in context) return context.unavailable;
  const { project, canEdit } = context;
  if (!canEdit) notFound();
  const definition = await createDrizzleEvalStore(getDb()).get(project.id, evalId);
  if (!definition) notFound();
  const version = currentVersion(definition);
  return (
    <EditEvalForm
      key={version.id}
      canEdit={canEdit}
      model={{
        projectId: project.id,
        id: definition.id,
        name: definition.name,
        taskId: definition.taskId,
        version: {
          id: version.id,
          number: version.number,
          sandboxName: version.sandboxName,
          params: version.params,
          trials: version.trials,
          scorers: version.scorers,
        },
      }}
    />
  );
}

async function pageContext(
  projectId: string,
  evalId: string,
): Promise<{ unavailable: ReactNode } | { project: { id: string }; canEdit: boolean }> {
  // Next renders a page next to its layout: the layout's 404 does not stop this data.
  if (!(await evalsEnabledForProject(projectId))) notFound();
  if (!isDbConfigured()) {
    return {
      unavailable: (
        <DatabaseUnavailable title="Evals">
          Evals become available once setup finishes.
        </DatabaseUnavailable>
      ),
    };
  }
  if (!(await getSessionContext())) redirect("/");
  if (!z.uuid().safeParse(evalId).success) notFound();
  const { project } = await getProjectScope(projectId);
  return { project, canEdit: !(await isRestrictedBySupportSession()) };
}
