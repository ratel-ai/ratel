import { z } from "zod";
import { getDb } from "@/lib/platform/db/client";
import { listSandboxVersions, type SandboxVersionSummary } from "@/lib/views/sandboxes";
import { listScorers } from "@/lib/views/scorers/store";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import { createDrizzleBaselineStore } from "./adapters/drizzle-baseline-store";
import { createDrizzleDatasetStore } from "./adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "./adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "./adapters/drizzle-experiment-store";
import { projectTaskNames } from "./adapters/task-names";
import type { Compared } from "./baseline";
import { datasetPageModel, datasetsPageModel, KIND_LABELS } from "./datasets-page";
import { currentVersion, type EvalDefinition } from "./domain/eval";
import type { Trial } from "./domain/experiment";
import type { FormContext, RunDefaults, SandboxOption } from "./eval-form";
import { libraryKey } from "./eval-form";
import { evalPageModel } from "./eval-page";
import { evalsPageModel } from "./evals-page";
import { evalHistory, evalsOverview, withPinnedRuns } from "./history-view";
import { PREVIEW_CHARS } from "./page-model";
import { runPageModel } from "./run-page";
import { listScorerLibrary } from "./scorer-library";
import { pairedTrial } from "./suite-view";

/**
 * The server reads of the Datasets and Evals pages. Each read is scoped to the project of the
 * member: an id of another project finds nothing, and the page answers 404.
 */

/** A trial and its run. The trial panel reads its output and tool calls, with the content rule. */
export type TrialSide = { runId: string; trial: Trial };

/** The runs of the project that a history reads, the newest. As the API reads them. */
const HISTORY_RUNS = 100;
const VERSIONS = 50;

export type DialogData = FormContext & {
  datasets: Array<{ id: string; name: string; kindLabel: string }>;
  tasks: Array<{ id: string; name: string }>;
};

export async function loadDatasetsPage(projectId: string) {
  const db = getDb();
  const [datasets, evals, names] = await Promise.all([
    createDrizzleDatasetStore(db).list(projectId),
    createDrizzleEvalStore(db).list(projectId),
    projectTaskNames(projectId),
  ]);
  return {
    model: datasetsPageModel(projectId, datasets, evals, names),
    tasks: taskList(names),
  };
}

export async function loadDatasetPage(projectId: string, datasetId: string) {
  if (!z.uuid().safeParse(datasetId).success) return null;
  const db = getDb();
  const store = createDrizzleDatasetStore(db);
  const dataset = await store.get(projectId, datasetId);
  if (!dataset) return null;
  const [rows, evals, readContent, names] = await Promise.all([
    store.rows(projectId, dataset.id),
    createDrizzleEvalStore(db).list(projectId),
    contentOptIn(projectId),
    projectTaskNames(projectId),
  ]);
  return {
    model: datasetPageModel({ projectId, dataset, rows, evals, readContent, taskNames: names }),
    readContent,
  };
}

export async function loadEvalsPage(projectId: string) {
  const db = getDb();
  const [definitions, datasets, recent, dialog] = await Promise.all([
    createDrizzleEvalStore(db).list(projectId),
    createDrizzleDatasetStore(db).list(projectId),
    recentRuns(projectId),
    dialogData(projectId),
  ]);
  const baselines = createDrizzleBaselineStore(db);
  const pins = await Promise.all(
    definitions.map(
      async ({ id }) => [id, (await baselines.get(projectId, id))?.experimentId] as const,
    ),
  );
  const runs = await withPinnedRuns(
    recent,
    pins.map(([, run]) => run),
    (id) => oneRun(projectId, id),
  );
  const overview = evalsOverview({
    evals: definitions,
    rowCounts: new Map(datasets.map(({ id, rowCount }) => [id, rowCount])),
    runs,
    baselines: new Map(pins.flatMap(([id, run]) => (run ? [[id, run]] : []))),
  });
  return {
    model: evalsPageModel({ projectId, overview, evals: definitions, datasets }),
    dialog,
  };
}

export async function loadEvalPage(projectId: string, evalId: string) {
  if (!z.uuid().safeParse(evalId).success) return null;
  const db = getDb();
  const definition = await createDrizzleEvalStore(db).get(projectId, evalId);
  if (!definition) return null;
  const [pin, recent, datasets, dialog] = await Promise.all([
    createDrizzleBaselineStore(db).get(projectId, definition.id),
    recentRuns(projectId),
    createDrizzleDatasetStore(db).list(projectId),
    dialogData(projectId),
  ]);
  const runs = await withPinnedRuns(recent, [pin?.experimentId], (id) => oneRun(projectId, id));
  const baseline = runs.find(({ experiment }) => experiment.id === pin?.experimentId) ?? null;
  const history = evalHistory({ definition, runs, baseline });
  const model = evalPageModel({
    projectId,
    definition,
    history,
    runs,
    datasets: new Map(datasets.map(({ id, name, query }) => [id, { name, kind: query.kind }])),
    kindLabels: KIND_LABELS,
  });
  return { model, dialog, defaults: runDefaults(definition), definition: editDraftOf(definition) };
}

export async function loadRunPage(projectId: string, evalId: string, runId: string) {
  if (!z.uuid().safeParse(evalId).success || !z.uuid().safeParse(runId).success) return null;
  const db = getDb();
  const store = createDrizzleExperimentStore(db);
  const [definition, experiment] = await Promise.all([
    createDrizzleEvalStore(db).get(projectId, evalId),
    store.get(projectId, runId),
  ]);
  if (!definition || !experiment || !runOfEval(experiment, evalId)) return null;
  const [trials, versions, outputs, readContent] = await Promise.all([
    store.trials(experiment.id),
    store.caseVersions(experiment.caseVersions.map(({ versionId }) => versionId)),
    // One more character than the grid shows, so a cut output gets its "…".
    store.outputPreviews(experiment.id, PREVIEW_CHARS + 1),
    contentOptIn(projectId),
  ]);
  return {
    evalName: definition.name,
    model: runPageModel({ projectId, evalId, experiment, trials, versions, outputs, readContent }),
  };
}

/**
 * One trial of a run of the eval, and the trial of the same row, variant and number in the
 * pinned baseline run of the eval.
 */
export async function loadTrialPair(
  projectId: string,
  evalId: string,
  runId: string,
  trialId: string,
): Promise<{
  evalName: string;
  caseName: string;
  candidate: TrialSide;
  baseline: TrialSide | null;
} | null> {
  for (const id of [evalId, runId, trialId]) if (!z.uuid().safeParse(id).success) return null;
  const db = getDb();
  const [definition, run, pin] = await Promise.all([
    createDrizzleEvalStore(db).get(projectId, evalId),
    oneRun(projectId, runId),
    createDrizzleBaselineStore(db).get(projectId, evalId),
  ]);
  if (!definition || !run || !runOfEval(run.experiment, evalId)) return null;
  const other =
    pin && pin.experimentId !== run.experiment.id
      ? await oneRun(projectId, pin.experimentId)
      : null;
  const paired = pairedTrial(run, other, trialId);
  if (!paired) return null;
  return {
    evalName: definition.name,
    caseName: paired.caseName,
    candidate: { runId: run.experiment.id, trial: paired.trial },
    baseline:
      paired.baselineTrial && paired.baselineId
        ? { runId: paired.baselineId, trial: paired.baselineTrial }
        : null,
  };
}

/** The data of the dialogs: sandboxes, the scorer library, the datasets and the tasks. */
export async function dialogData(projectId: string): Promise<DialogData> {
  const db = getDb();
  const [versions, library, datasets, names] = await Promise.all([
    listSandboxVersions(projectId, VERSIONS),
    listScorerLibrary(projectId, {
      library: { projectScorers: (id) => listScorers(id, db) },
      evals: createDrizzleEvalStore(db),
    }),
    createDrizzleDatasetStore(db).list(projectId),
    projectTaskNames(projectId),
  ]);
  return {
    sandboxes: sandboxOptions(versions),
    library: library.filter(({ source }) => source !== "eval"),
    datasets: datasets.map(({ id, name, query }) => ({
      id,
      name,
      kindLabel: KIND_LABELS[query.kind],
    })),
    tasks: taskList(names),
  };
}

/** Each sandbox with its ready versions, the newest first. */
export function sandboxOptions(versions: readonly SandboxVersionSummary[]): SandboxOption[] {
  const sandboxes = new Map<string, SandboxOption>();
  const newestFirst = [...versions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  for (const version of newestFirst) {
    if (version.status !== "ready") continue;
    const sandbox = sandboxes.get(version.name) ?? { name: version.name, versions: [] };
    sandbox.versions.push({
      id: version.id,
      label: `${version.git?.commit.slice(0, 7) ?? version.id.slice(0, 8)} · ${version.createdAt.toISOString().slice(0, 16).replace("T", " ")}`,
      params: version.params,
    });
    sandboxes.set(version.name, sandbox);
  }
  return [...sandboxes.values()];
}

/** What a run of the eval uses unless it changes it. */
export function runDefaults(definition: EvalDefinition): RunDefaults {
  const version = currentVersion(definition);
  return {
    datasetId: version.datasetId,
    sandboxName: version.sandboxName,
    versionId: version.sandboxVersionId,
    params: version.params,
    matrix: version.matrix,
    trials: version.trials,
    scorers: version.scorers.flatMap((scorer) => {
      const { ref } = scorer;
      if (!ref) return [];
      const key =
        ref.source === "project"
          ? libraryKey({ source: "project", id: ref.scorerId })
          : libraryKey({ source: "predefined", id: ref.key });
      const settings =
        ref.source === "predefined"
          ? Object.fromEntries(Object.entries(ref.settings).map(([k, v]) => [k, String(v)]))
          : {};
      return [{ key, gating: scorer.gating, settings }];
    }),
  };
}

/** The eval as the "Edit" dialog starts: its newest version. */
export function editDraftOf(definition: EvalDefinition) {
  const version = currentVersion(definition);
  const defaults = runDefaults(definition);
  return {
    evalId: definition.id,
    base: version.id,
    name: definition.name,
    taskId: definition.taskId ?? "",
    sandboxName: version.sandboxName,
    versionId: version.sandboxVersionId,
    datasetId: version.datasetId,
    params: version.params,
    matrix: version.matrix,
    trials: version.trials,
    scorers: defaults.scorers,
    /** Scorers that the eval holds itself: the library has no reference to them. */
    keptScorers: version.scorers.filter(({ ref }) => !ref).map(({ name }) => name),
  };
}
export type EditDraft = ReturnType<typeof editDraftOf>;

function runOfEval(experiment: Compared["experiment"], evalId: string): boolean {
  return (
    experiment.evalId === evalId ||
    (experiment.evalId === null && experiment.evalVersions.some((one) => one.evalId === evalId))
  );
}

async function recentRuns(projectId: string): Promise<Compared[]> {
  const store = createDrizzleExperimentStore(getDb());
  const list = await store.list(projectId, HISTORY_RUNS);
  return Promise.all(
    list.map(async (experiment) => ({ experiment, trials: await store.trials(experiment.id) })),
  );
}

async function oneRun(projectId: string, experimentId: string): Promise<Compared | null> {
  const store = createDrizzleExperimentStore(getDb());
  const experiment = await store.get(projectId, experimentId);
  return experiment ? { experiment, trials: await store.trials(experiment.id) } : null;
}

function taskList(names: ReadonlyMap<string, string>) {
  return [...names]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
