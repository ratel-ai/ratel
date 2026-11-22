import { Page, PageBody } from "@ratel/design-system/page-header";
import { notFound, redirect } from "next/navigation";
import { EvalEditor } from "@/components/console/evals/EvalEditor";
import { EvalHeader } from "@/components/console/evals/EvalHeader";
import { RUN_KIND_LABELS } from "@/components/console/evals/marks";
import { SingleTestView } from "@/components/console/evals/SingleTestView";
import { getProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { loadEvalEditor } from "@/lib/views/evals/editor-page";
import { loadEvalPage } from "@/lib/views/evals/page";
import { loadRunSettingsModel } from "@/lib/views/evals/run-settings";
import { evalRunReadings, evalScorerSwitches } from "@/lib/views/scorers/page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Eval" };

/** One eval at its last run, or at `?run=` (RC-292, D1/F1). RC-297: `?edit=1` opens the editor, `&run=&mock=<step>` with that step's answer filled in. */
export default async function EvalPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; evalId: string }>;
  searchParams: Promise<{
    run?: string | string[];
    edit?: string | string[];
    mock?: string | string[];
  }>;
}) {
  if (!isDbConfigured()) notFound();
  const context = await getSessionContext();
  if (!context) redirect("/");
  const [{ projectId, evalId }, query] = await Promise.all([params, searchParams]);
  const { project } = await getProjectScope(projectId, context.user.id);
  const runId = typeof query.run === "string" && query.run ? query.run : null;
  if (query.edit === "1") {
    const step =
      typeof query.mock === "string" && /^\d+$/.test(query.mock) ? Number(query.mock) : null;
    const editor = await loadEvalEditor(
      project.id,
      context.user.externalId,
      evalId,
      runId && step !== null ? { runId, step } : null,
    );
    if (!editor) notFound();
    const scorers = await evalScorerSwitches(project.id, editor.item.id, editor.item.tasks);
    const runSettings = await loadRunSettingsModel(project.id, editor.item);
    return (
      <Page>
        <EvalHeader
          projectId={project.id}
          evalId={editor.item.id}
          name={editor.item.name}
          runCount={editor.runCount}
          editing
        />
        <PageBody wide>
          <EvalEditor
            projectId={project.id}
            evalId={editor.item.id}
            message={editor.item.message}
            initial={editor.form}
            tasks={editor.tasks}
            tools={editor.tools}
            hints={editor.hints}
            mockAt={editor.mockAt}
            generated={editor.item.generated ?? []}
            runSettings={runSettings}
            scorers={scorers}
          />
        </PageBody>
      </Page>
    );
  }
  const model = await loadEvalPage(project.id, context.user.externalId, evalId, runId);
  if (!model) notFound();
  const readings = model.run
    ? await evalRunReadings(project.id, model.run.id, model.item.id, model.item.tasks)
    : null;
  const runLabel = model.run
    ? `${RUN_KIND_LABELS[model.run.kind]} · ${model.run.createdAt.toISOString().slice(0, 16).replace("T", " ")}`
    : null;
  return (
    <Page>
      <EvalHeader
        projectId={project.id}
        evalId={model.item.id}
        name={model.item.name}
        passed={model.result?.passed}
        runCount={model.runCount}
        runId={runId && model.run ? model.run.id : null}
        runLabel={runLabel}
        position={model.position}
      />
      <PageBody wide>
        <SingleTestView
          item={model.item}
          tasks={model.tasks}
          rules={model.rules}
          run={model.run}
          result={model.result}
          replayHref={model.replayHref}
          previous={model.previous?.result ?? null}
          pending={model.pending}
          readings={readings}
        />
      </PageBody>
    </Page>
  );
}
