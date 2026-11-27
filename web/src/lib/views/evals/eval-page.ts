import { KIND_LABELS } from "./dataset-pages";
import type { DatasetKind } from "./domain/dataset";
import { combinationCount, currentVersion, type EvalDefinition } from "./domain/eval";
import type { ChartSeries } from "./evals-page";
import { CHART_SLOTS } from "./evals-page";
import type { EvalHistory, EvalRunRow } from "./history-view";
import { datasetHref, experimentHref } from "./paths";

/**
 * The page model of one eval (decision `runs-per-eval`): its definition, a chart with a line for
 * the run score (the mean) and one for each scorer, and the table of its runs with what each one
 * used and how it scored against the baseline of the eval.
 */

export const MEAN_SERIES = "mean";

export type DatasetRef = { id: string; name: string; kind: DatasetKind };

export type EvalDefinitionView = {
  dataset: { name: string; kindLabel: string; href: string } | null;
  /** "support-demo · newest ready version" or "support-demo · pinned 1a2b3c4d5e6f". */
  runtime: string;
  scorers: string[];
  trials: number;
  /** "model=small" for each default param. */
  params: string[];
  /** "matrix (4)" with the count of combinations. Null: no matrix. */
  matrix: string | null;
};

export type RunTableRow = {
  experimentId: string;
  href: string;
  /** The name of the run, or its time. */
  title: string;
  at: string;
  running: boolean;
  dataset: { name: string; rows: number; href: string | null };
  runtime: { sandbox: string; version: string; commit: string };
  scorers: number;
  /** "model=large" for each param, or "matrix (n)". */
  params: string;
  score: number | null;
  delta: number | null;
  /** Why there is no delta. Null when there is one, or for the baseline. */
  deltaNote: string | null;
  invalid: number;
  isBaseline: boolean;
  /** What the run changed for itself only, in words. */
  changed: string[];
};

export type EvalPage = {
  projectId: string;
  evalId: string;
  name: string;
  taskId: string | null;
  definition: EvalDefinitionView;
  chart: { series: ChartSeries[]; runs: number };
  runs: RunTableRow[];
  baselineId: string | null;
};

export function evalPageModel({
  projectId,
  definition,
  history,
  datasets,
}: {
  projectId: string;
  definition: EvalDefinition;
  history: EvalHistory;
  datasets: readonly DatasetRef[];
}): EvalPage {
  const version = currentVersion(definition);
  const byId = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  const own = byId.get(version.datasetId);
  const matrixCount = combinationCount(version.matrix);
  return {
    projectId,
    evalId: definition.id,
    name: definition.name,
    taskId: definition.taskId,
    definition: {
      dataset: own
        ? { name: own.name, kindLabel: KIND_LABELS[own.kind], href: datasetHref(projectId, own.id) }
        : null,
      runtime: `${version.sandboxName ?? "The sandbox of the run"} · ${
        version.sandboxVersionId
          ? `pinned ${version.sandboxVersionId.slice(0, 8)}`
          : "newest ready version"
      }`,
      scorers: version.scorers.map(({ name }) => name),
      trials: version.trials,
      params: paramWords(version.params),
      matrix: Object.keys(version.matrix).length > 0 ? `matrix (${matrixCount})` : null,
    },
    chart: scorerChart(projectId, history),
    runs: history.runs.map((run) => runRow(projectId, run, byId)),
    baselineId: history.baselineId,
  };
}

/** One line for the run score (the mean of the variants), then one for each scorer. */
function scorerChart(projectId: string, history: EvalHistory): EvalPage["chart"] {
  const completed = [...history.runs].reverse().filter(({ state }) => state === "completed");
  const mean: ChartSeries = {
    id: MEAN_SERIES,
    name: "Score (mean)",
    slot: 0,
    points: completed.map((run) => ({
      experimentId: run.experimentId,
      href: experimentHref(projectId, run.experimentId),
      at: run.at,
      score: run.score,
    })),
  };
  const scorers = history.scorerSeries.slice(0, CHART_SLOTS - 1).map(
    (series, index): ChartSeries => ({
      id: series.scorerId,
      name: series.gating ? series.name : `${series.name} (advisory)`,
      slot: index + 1,
      points: series.points.map((point) => ({
        experimentId: point.experimentId,
        href: experimentHref(projectId, point.experimentId),
        at: point.at,
        score: point.passRate,
      })),
    }),
  );
  return {
    series: [mean, ...scorers],
    runs: mean.points.filter(({ score }) => score !== null).length,
  };
}

function runRow(
  projectId: string,
  run: EvalRunRow,
  datasets: ReadonlyMap<string, DatasetRef>,
): RunTableRow {
  const dataset = run.datasetId ? datasets.get(run.datasetId) : undefined;
  return {
    experimentId: run.experimentId,
    href: experimentHref(projectId, run.experimentId),
    title: run.name ?? run.at,
    at: run.at,
    running: run.state === "running",
    dataset: {
      name: dataset?.name ?? "Its eval's rows",
      rows: run.rows,
      href: dataset ? datasetHref(projectId, dataset.id) : null,
    },
    runtime: {
      sandbox: run.sandboxName,
      version: run.sandboxVersionId.slice(0, 8),
      commit: run.gitCommit.slice(0, 12),
    },
    scorers: run.scorers.length,
    params:
      run.variants.length > 1
        ? `matrix (${run.variants.length})`
        : paramWords(run.variants[0]?.params ?? run.params).join(", ") || "Defaults",
    score: run.score,
    delta: run.delta?.score ?? null,
    deltaNote: run.isBaseline
      ? null
      : (run.deltaRefusal?.message ?? (run.delta ? null : "No baseline")),
    invalid: run.invalid,
    isBaseline: run.isBaseline,
    changed: changedWords(run, datasets),
  };
}

/** What a run changed for itself only, in words, in a fixed order. */
function changedWords(run: EvalRunRow, datasets: ReadonlyMap<string, DatasetRef>): string[] {
  const { changes } = run;
  const words: string[] = [];
  if (changes.datasetId) {
    words.push(`dataset ${datasets.get(changes.datasetId)?.name ?? changes.datasetId.slice(0, 8)}`);
  }
  if (changes.addedRows) {
    words.push(changes.addedRows === 1 ? "1 row added" : `${changes.addedRows} rows added`);
  }
  if (changes.scorers) words.push("other scorers");
  if (changes.sandboxVersionId) words.push(`pinned ${changes.sandboxVersionId.slice(0, 8)}`);
  if (changes.params && Object.keys(changes.params).length > 0) {
    words.push(paramWords(changes.params).join(", "));
  }
  if (changes.matrix) {
    words.push(
      Object.keys(changes.matrix).length === 0
        ? "no matrix"
        : `matrix (${combinationCount(changes.matrix)})`,
    );
  }
  if (changes.trials) words.push(changes.trials === 1 ? "1 trial" : `${changes.trials} trials`);
  return words;
}

function paramWords(params: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(params).map(
    ([name, value]) => `${name}=${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
}
