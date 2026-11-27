import { z } from "zod";
import type { Compared } from "./baseline";
import type { CaseContent, EvalCase } from "./domain/case";
import {
  type Dataset,
  type DatasetDefinition,
  datasetDetailsSchema,
  datasetSettingsSchema,
} from "./domain/dataset";
import {
  currentVersion,
  type EvalContent,
  type EvalDefinition,
  type EvalDetails,
  evalContentSchema,
  evalDetailsSchema,
} from "./domain/eval";
import { type LibraryScorer, libraryOf } from "./domain/scorer-library";
import {
  type DatasetListRow,
  datasetsList,
  type EvalRunsView,
  type EvalsOverview,
  evalRunsView,
  evalsOverview,
} from "./history-view";
import type { BaselineStore } from "./ports/baseline-store";
import type { CaseRefusal, CaseStore } from "./ports/case-store";
import type { DatasetStore } from "./ports/dataset-store";
import type { EvalStore } from "./ports/eval-store";
import type { ExperimentStore } from "./ports/experiment-store";
import type { ScorerLibraryPort } from "./ports/scorer-library";

/**
 * The reads and the writes of datasets and evals that the API routes and the MCP operations share
 * (decision `mcp-surface`): each one calls these, so the two paths do the same work. Each read and
 * write is of one project: an id of another project is not found.
 */

export type EvalsServiceDeps = {
  evals: EvalStore;
  datasets: DatasetStore;
  cases: Pick<CaseStore, "createAll" | "listDataset">;
  experiments: Pick<ExperimentStore, "listOfEval" | "get" | "trials">;
  baselines: Pick<BaselineStore, "get" | "ofEvals">;
  library: ScorerLibraryPort;
};

/** The runs of one eval that the overview and the eval read. */
export const RUNS_OF_EVAL = 30;

export const newDatasetSchema = datasetDetailsSchema.extend({
  definition: datasetSettingsSchema.default({ kind: "fixed" }),
});
export type NewDatasetInput = z.input<typeof newDatasetSchema>;

export const newEvalSchema = evalDetailsSchema.extend({
  content: evalContentSchema.default(evalContentSchema.parse({})),
});
export type NewEvalInput = EvalDetails & { content: EvalContent };

/** The evals of the project, each with its rows, scorers, baseline score, newest score and series. */
export async function loadOverview(
  projectId: string,
  deps: EvalsServiceDeps,
): Promise<EvalsOverview> {
  const [evals, datasets, stats, pins] = await Promise.all([
    deps.evals.list(projectId),
    deps.datasets.list(projectId),
    deps.datasets.rowStats(projectId),
    deps.baselines.ofEvals(projectId),
  ]);
  const runs = new Map(
    await Promise.all(
      evals.map(async ({ id }) => [id, await runsOf(projectId, id, deps)] as const),
    ),
  );
  return evalsOverview({
    evals,
    datasets,
    rowCounts: new Map([...stats].map(([id, { rows }]) => [id, rows])),
    runs,
    baselines: new Map([...pins].map(([id, pin]) => [id, pin.experimentId])),
  });
}

/** An eval by its id or its name. */
export async function findEval(
  projectId: string,
  wanted: string,
  evals: Pick<EvalStore, "get" | "getByName">,
): Promise<EvalDefinition | null> {
  const byId = z.uuid().safeParse(wanted).success ? await evals.get(projectId, wanted) : null;
  return byId ?? (await evals.getByName(projectId, wanted));
}

/** A dataset by its id or its name. */
export async function findDataset(
  projectId: string,
  wanted: string,
  datasets: Pick<DatasetStore, "get" | "getByName">,
): Promise<Dataset | null> {
  const byId = z.uuid().safeParse(wanted).success ? await datasets.get(projectId, wanted) : null;
  return byId ?? (await datasets.getByName(projectId, wanted));
}

export type EvalRead = {
  definition: EvalDefinition;
  dataset: Dataset | null;
  runs: EvalRunsView;
};

/** One eval with its dataset and its runs. Null when the project has no such eval. */
export async function loadEval(
  projectId: string,
  wanted: string,
  deps: EvalsServiceDeps,
): Promise<EvalRead | null> {
  const definition = await findEval(projectId, wanted, deps.evals);
  if (!definition) return null;
  const version = currentVersion(definition);
  const [runs, pin, dataset] = await Promise.all([
    runsOf(projectId, definition.id, deps),
    deps.baselines.get(projectId, definition.id),
    version.datasetId ? deps.datasets.get(projectId, version.datasetId) : null,
  ]);
  const baseline =
    runs.find(({ experiment }) => experiment.id === pin?.experimentId) ??
    (pin ? await compared(projectId, pin.experimentId, deps) : null);
  return { definition, dataset, runs: evalRunsView(definition, runs, baseline) };
}

/** The datasets of the project with their kind, rows or query, and the evals that use each. */
export async function loadDatasets(
  projectId: string,
  deps: EvalsServiceDeps,
): Promise<DatasetListRow[]> {
  const [datasets, stats, evals] = await Promise.all([
    deps.datasets.list(projectId),
    deps.datasets.rowStats(projectId),
    deps.evals.list(projectId),
  ]);
  return datasetsList(datasets, stats, evals);
}

export type DatasetRead = { dataset: Dataset; rows: EvalCase[]; evals: DatasetListRow["evals"] };

/** One dataset with the rows of a fixed one. Null when the project has no such dataset. */
export async function loadDataset(
  projectId: string,
  wanted: string,
  deps: EvalsServiceDeps,
): Promise<DatasetRead | null> {
  const dataset = await findDataset(projectId, wanted, deps.datasets);
  if (!dataset) return null;
  const [rows, evals] = await Promise.all([
    dataset.definition.kind === "fixed" ? deps.cases.listDataset(projectId, dataset.id) : [],
    deps.evals.list(projectId),
  ]);
  return {
    dataset,
    rows,
    evals: evals
      .filter((one) => currentVersion(one).datasetId === dataset.id)
      .map(({ id, name }) => ({ evalId: id, name })),
  };
}

export async function createDataset(
  projectId: string,
  input: { name: string; definition: DatasetDefinition },
  createdBy: string,
  deps: Pick<EvalsServiceDeps, "datasets">,
): Promise<Dataset | "name_taken"> {
  return deps.datasets.create({ projectId, ...input, createdBy });
}

/** A row that a person or an agent adds to a fixed dataset. */
export type NewRow = {
  name: string;
  labels?: string[];
  content: CaseContent;
  source?: { turnId: string | null; output: string | null };
};

/** Adds rows to a fixed dataset, in one transaction. They count at once. */
export async function addRows(
  projectId: string,
  datasetId: string,
  rows: readonly NewRow[],
  createdBy: string,
  deps: Pick<EvalsServiceDeps, "cases">,
): Promise<EvalCase[] | CaseRefusal> {
  return deps.cases.createAll(
    rows.map((row) => ({
      projectId,
      datasetId,
      name: row.name,
      labels: [...new Set(row.labels ?? [])],
      content: row.content,
      createdBy,
      ...(row.source ? { source: row.source } : {}),
    })),
  );
}

/** The scorer library of the project: its scorers, the pre-defined set, and the evals' own. */
export async function loadLibrary(
  projectId: string,
  deps: Pick<EvalsServiceDeps, "evals" | "library">,
): Promise<LibraryScorer[]> {
  const [scorers, evals] = await Promise.all([
    deps.library.projectScorers(projectId),
    deps.evals.list(projectId),
  ]);
  return libraryOf(
    scorers,
    evals.map((one) => ({ id: one.id, name: one.name, scorers: currentVersion(one).scorers })),
  );
}

async function runsOf(
  projectId: string,
  evalId: string,
  deps: Pick<EvalsServiceDeps, "experiments">,
): Promise<Compared[]> {
  const experiments = await deps.experiments.listOfEval(projectId, evalId, RUNS_OF_EVAL);
  return Promise.all(
    experiments.map(async (experiment) => ({
      experiment,
      trials: await deps.experiments.trials(experiment.id),
    })),
  );
}

async function compared(
  projectId: string,
  experimentId: string,
  deps: Pick<EvalsServiceDeps, "experiments">,
): Promise<Compared | null> {
  const experiment = await deps.experiments.get(projectId, experimentId);
  return experiment ? { experiment, trials: await deps.experiments.trials(experiment.id) } : null;
}
