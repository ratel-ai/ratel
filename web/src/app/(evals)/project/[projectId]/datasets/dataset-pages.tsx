import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { z } from "zod";
import { DatasetsList } from "@/components/console/evals/DatasetsList";
import { DatasetView } from "@/components/console/evals/DatasetView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { createDrizzleDatasetStore } from "@/lib/views/evals/adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "@/lib/views/evals/adapters/drizzle-eval-store";
import { loadPickerOptions } from "@/lib/views/evals/adapters/turn-picker";
import { datasetPageModel, datasetsPageModel } from "@/lib/views/evals/dataset-pages";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import { datasetsView } from "@/lib/views/evals/history-view";

/**
 * The server side of the Datasets pages (the `evals` flag). Next renders a page next to its
 * layout, so each page reads the flag again before it loads data: with the flag off it answers 404
 * and loads nothing (decision `flag-off-page-status`).
 */
export async function datasetsListPage(projectId: string): Promise<ReactNode> {
  const context = await pageContext(projectId);
  if ("unavailable" in context) return context.unavailable;
  const { project, canEdit } = context;
  const [summaries, evals, options] = await withFeatureSpan(
    "evals",
    "load_datasets",
    () => {
      const db = getDb();
      return Promise.all([
        createDrizzleDatasetStore(db).list(project.id),
        createDrizzleEvalStore(db).list(project.id),
        loadPickerOptions(project.id, db),
      ]);
    },
    { attributes: { "project.id": project.id } },
  );
  return (
    <DatasetsList
      projectId={project.id}
      rows={datasetsPageModel(project.id, datasetsView(summaries, evals))}
      options={options}
      canEdit={canEdit}
      now={new Date().toISOString()}
    />
  );
}

export async function datasetPage(projectId: string, datasetId: string): Promise<ReactNode> {
  const context = await pageContext(projectId);
  if ("unavailable" in context) return context.unavailable;
  const { project, canEdit } = context;
  if (!z.uuid().safeParse(datasetId).success) notFound();
  const loaded = await withFeatureSpan(
    "evals",
    "load_dataset",
    async () => {
      const db = getDb();
      const datasets = createDrizzleDatasetStore(db);
      const dataset = await datasets.get(project.id, datasetId);
      if (!dataset) return null;
      const [rows, evals, options] = await Promise.all([
        dataset.query.kind === "fixed" ? datasets.rows(project.id, dataset.id) : [],
        createDrizzleEvalStore(db).list(project.id),
        loadPickerOptions(project.id, db),
      ]);
      return { dataset, rows, evals, options };
    },
    { attributes: { "project.id": project.id } },
  );
  if (!loaded) notFound();
  const { options, ...rest } = loaded;
  return (
    <DatasetView
      model={datasetPageModel({ projectId: project.id, ...rest })}
      options={options}
      canEdit={canEdit}
      now={new Date().toISOString()}
    />
  );
}

async function pageContext(
  projectId: string,
): Promise<{ unavailable: ReactNode } | { project: { id: string }; canEdit: boolean }> {
  if (!(await evalsEnabledForProject(projectId))) notFound();
  if (!isDbConfigured()) {
    return {
      unavailable: (
        <DatabaseUnavailable title="Datasets">
          Datasets become available once setup finishes.
        </DatabaseUnavailable>
      ),
    };
  }
  if (!(await getSessionContext())) redirect("/");
  const { project } = await getProjectScope(projectId);
  return { project, canEdit: !(await isRestrictedBySupportSession()) };
}
