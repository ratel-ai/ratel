import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { DatasetsList } from "@/components/console/evals/DatasetsList";
import { DatasetView } from "@/components/console/evals/DatasetView";
import { EvalsList } from "@/components/console/evals/EvalsList";
import { EvalView } from "@/components/console/evals/EvalView";
import { RunView } from "@/components/console/evals/RunView";
import { TrialView } from "@/components/console/evals/TrialView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { withFeatureSpan } from "@/lib/contracts/feature-spans";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { evalsEnabledForProject } from "@/lib/views/evals/gate";
import {
  dialogData,
  loadDatasetPage,
  loadDatasetsPage,
  loadEvalPage,
  loadEvalsPage,
  loadRunPage,
  loadTrialPair,
} from "@/lib/views/evals/pages-load";
import { loadTrialViews } from "@/lib/views/evals/trial-views";

/**
 * The server side of the Datasets and Evals pages (the `evals` flag). Next renders a page next to
 * its layout, so each page reads the flag again before it loads data: with the flag off it answers
 * 404 and loads nothing (decision `flag-off-page-status`). Each read is scoped to the project.
 */

export async function datasetsPage(projectId: string): Promise<ReactNode> {
  const context = await pageContext(projectId);
  if ("unavailable" in context) return context.unavailable;
  const { project, canEdit } = context;
  const { model, tasks } = await span("load_datasets", project.id, () =>
    loadDatasetsPage(project.id),
  );
  return (
    <DatasetsList model={model} tasks={tasks} canEdit={canEdit} now={new Date().toISOString()} />
  );
}

export async function datasetPage(projectId: string, datasetId: string): Promise<ReactNode> {
  const context = await pageContext(projectId);
  if ("unavailable" in context) return context.unavailable;
  const { project, canEdit } = context;
  const [loaded, dialog] = await span("load_dataset", project.id, () =>
    Promise.all([loadDatasetPage(project.id, datasetId), dialogData(project.id)]),
  );
  if (!loaded) notFound();
  return (
    <DatasetView
      model={loaded.model}
      tasks={dialog.tasks}
      canEdit={canEdit}
      now={new Date().toISOString()}
    />
  );
}

export async function evalsPage(projectId: string, openNew: boolean): Promise<ReactNode> {
  const context = await pageContext(projectId);
  if ("unavailable" in context) return context.unavailable;
  const { project, canEdit } = context;
  const { model, dialog } = await span("load_page", project.id, () => loadEvalsPage(project.id));
  return <EvalsList model={model} dialog={dialog} canEdit={canEdit} openNew={openNew && canEdit} />;
}

export async function evalPage(projectId: string, evalId: string): Promise<ReactNode> {
  const context = await pageContext(projectId);
  if ("unavailable" in context) return context.unavailable;
  const { project, canEdit } = context;
  const loaded = await span("load_eval", project.id, () => loadEvalPage(project.id, evalId));
  if (!loaded) notFound();
  return (
    <EvalView
      model={loaded.model}
      dialog={loaded.dialog}
      defaults={loaded.defaults}
      edit={loaded.definition}
      canEdit={canEdit}
      now={new Date().toISOString()}
    />
  );
}

export async function runPage(
  projectId: string,
  evalId: string,
  runId: string,
): Promise<ReactNode> {
  const context = await pageContext(projectId);
  if ("unavailable" in context) return context.unavailable;
  const { project } = context;
  const loaded = await span("load_experiment", project.id, () =>
    loadRunPage(project.id, evalId, runId),
  );
  if (!loaded) notFound();
  return <RunView model={loaded.model} evalName={loaded.evalName} />;
}

export async function trialPage(
  projectId: string,
  evalId: string,
  runId: string,
  trialId: string,
): Promise<ReactNode> {
  const context = await pageContext(projectId);
  if ("unavailable" in context) return context.unavailable;
  const { project } = context;
  const loaded = await span("load_trial", project.id, async () => {
    const pair = await loadTrialPair(project.id, evalId, runId, trialId);
    if (!pair) return null;
    const tracesHref = `/project/${project.id}/traces`;
    const [views, baselineViews] = await Promise.all([
      loadTrialViews(project.id, pair.candidate.trial.traceId, tracesHref),
      pair.baseline ? loadTrialViews(project.id, pair.baseline.trial.traceId, tracesHref) : null,
    ]);
    return { pair, views, baselineViews };
  });
  if (!loaded) notFound();
  return (
    <TrialView
      projectId={project.id}
      evalId={evalId}
      {...loaded.pair}
      views={loaded.views}
      baselineViews={loaded.baselineViews}
    />
  );
}

async function pageContext(projectId: string) {
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
  const { project } = await getProjectScope(projectId);
  return { project, canEdit: !(await isRestrictedBySupportSession()) };
}

function span<T>(operation: string, projectId: string, work: () => Promise<T>): Promise<T> {
  return withFeatureSpan("evals", operation, work, { attributes: { "project.id": projectId } });
}
