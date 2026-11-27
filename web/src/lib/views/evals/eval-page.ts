import type { Compared } from "./baseline";
import type { DatasetKind } from "./domain/dataset";
import { combinationCount, currentVersion, type EvalDefinition } from "./domain/eval";
import { countTrials, type RunChanges } from "./domain/experiment";
import type { EvalHistory } from "./history-view";
import { datasetHref, runHref } from "./paths";
import { type ScoreChart, scoreChart } from "./score-chart";

/**
 * One eval (decision `runs-per-eval`): its definition, a chart with one line for each scorer and
 * one for the mean of the runs, then the table of its runs, the newest first. Plain data.
 */

export type DatasetRef = { name: string; kind: DatasetKind };

export type EvalDefinitionView = {
  versionId: string;
  version: number;
  taskId: string | null;
  dataset: { id: string; name: string; kindLabel: string; href: string };
  runtime: {
    sandboxName: string | null;
    /** A pinned version id. Null: the newest ready version. */
    pinnedVersionId: string | null;
    text: string;
  };
  scorers: Array<{ id: string; name: string; gating: boolean; source: string }>;
  trials: number;
  params: Record<string, unknown>;
  matrix: Record<string, unknown[]>;
  /** The combinations of the matrix. 0: no matrix. */
  combinations: number;
};

export type EvalRunView = {
  runId: string;
  href: string;
  /** The name that the person gave the run, else its time. */
  name: string | null;
  at: string;
  state: "running" | "completed";
  dataset: { id: string | null; name: string; href: string | null; rows: number };
  runtime: { sandboxName: string; versionId: string; commit: string };
  scorers: string[];
  /** "matrix (4)", the params that differ from nothing ("tone=formal"), or "Defaults". */
  params: string;
  score: number | null;
  delta: number | null;
  /** Why there is no delta while a baseline is pinned. */
  deltaNote: string | null;
  invalid: number;
  isBaseline: boolean;
  /** Only a completed run can be the baseline. */
  canPin: boolean;
  /** What the run changed for itself only, in words. */
  changed: string[];
};

export type EvalPageModel = {
  projectId: string;
  evalId: string;
  name: string;
  definition: EvalDefinitionView;
  chart: ScoreChart;
  runs: EvalRunView[];
  baselineId: string | null;
  rule: string;
};

const MEAN_KEY = "__mean__";

export function evalPageModel({
  projectId,
  definition,
  history,
  runs,
  datasets,
  kindLabels,
}: {
  projectId: string;
  definition: EvalDefinition;
  history: EvalHistory;
  /** The runs that the history read, with their trials. */
  runs: readonly Compared[];
  datasets: ReadonlyMap<string, DatasetRef>;
  kindLabels: Readonly<Record<DatasetKind, string>>;
}): EvalPageModel {
  const version = currentVersion(definition);
  const byId = new Map(runs.map((run) => [run.experiment.id, run]));
  const dataset = datasets.get(version.datasetId);
  const mean = [...history.runs]
    .reverse()
    .filter(({ state }) => state === "completed")
    .map(({ experimentId, at, score }) => ({ runId: experimentId, at, value: score }));
  const chart = scoreChart(
    [
      ...history.scorerSeries.map((series) => ({
        key: series.scorerId,
        label: series.name,
        points: series.points.map(({ experimentId, at, passRate }) => ({
          runId: experimentId,
          at,
          value: passRate,
        })),
      })),
      { key: MEAN_KEY, label: "Score (mean)", mean: true, points: mean },
    ],
    "scorers",
  );
  return {
    projectId,
    evalId: definition.id,
    name: definition.name,
    definition: {
      versionId: version.id,
      version: version.number,
      taskId: definition.taskId,
      dataset: {
        id: version.datasetId,
        name: dataset?.name ?? "A dataset that is gone",
        kindLabel: dataset ? kindLabels[dataset.kind] : "",
        href: datasetHref(projectId, version.datasetId),
      },
      runtime: {
        sandboxName: version.sandboxName,
        pinnedVersionId: version.sandboxVersionId,
        text: runtimeText(version.sandboxName, version.sandboxVersionId),
      },
      scorers: version.scorers.map(({ id, name, gating, ref }) => ({
        id,
        name,
        gating,
        source:
          ref?.source === "predefined"
            ? "Pre-defined"
            : ref?.source === "project"
              ? "This project"
              : "This eval",
      })),
      trials: version.trials,
      params: version.params,
      matrix: version.matrix,
      combinations: Object.keys(version.matrix).length === 0 ? 0 : combinationCount(version.matrix),
    },
    chart,
    baselineId: history.baselineId,
    rule: history.rule,
    runs: history.runs.map((row): EvalRunView => {
      const run = byId.get(row.experimentId);
      const ref = row.datasetId ? datasets.get(row.datasetId) : undefined;
      const counts = run ? countTrials(run.trials) : null;
      return {
        runId: row.experimentId,
        href: runHref(projectId, definition.id, row.experimentId),
        name: run?.experiment.name ?? null,
        at: row.at,
        state: row.state,
        dataset: {
          id: row.datasetId,
          name: ref?.name ?? (row.datasetId ? "A dataset that is gone" : "The cases of the suite"),
          href: row.datasetId ? datasetHref(projectId, row.datasetId) : null,
          rows: frozenRows(run, definition.id),
        },
        runtime: {
          sandboxName: row.sandboxName,
          versionId: row.sandboxVersionId,
          commit: run?.experiment.gitCommit.slice(0, 7) ?? "",
        },
        scorers: row.scorers,
        params:
          row.variants.length > 0
            ? `matrix (${row.variants.length})`
            : paramsText(row.params),
        score: row.score,
        delta: row.delta?.score ?? null,
        deltaNote: row.deltaRefusal?.message ?? null,
        invalid: counts?.invalid ?? 0,
        isBaseline: row.isBaseline,
        canPin: row.state === "completed" && !row.isBaseline,
        changed: run ? changedText(run.experiment.changes) : [],
      };
    }),
  };
}

/** The runtime of an eval in words. */
export function runtimeText(sandboxName: string | null, pinned: string | null): string {
  if (!sandboxName) return "The sandbox of each run";
  return pinned
    ? `${sandboxName}, version ${pinned.slice(0, 8)}`
    : `${sandboxName}, newest ready version`;
}

/** Params as `name=value`, in the order of their names. "Defaults" with none. */
export function paramsText(params: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return "Defaults";
  return entries
    .map(([name, value]) => `${name}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

/** What a run changed for itself only, in words, in a fixed order. */
export function changedText(changes: RunChanges): string[] {
  const words: string[] = [];
  if (changes.datasetId !== undefined) words.push("dataset");
  if (changes.addedRows) words.push(`${changes.addedRows} added rows`);
  if (changes.scorers) words.push("scorers");
  if (changes.sandboxVersionId !== undefined) words.push("runtime version");
  if (changes.params && Object.keys(changes.params).length > 0) words.push("params");
  if (changes.matrix !== undefined) words.push("matrix");
  if (changes.trials !== undefined) words.push("trials");
  return words;
}

/** The rows that the run froze for the eval. */
function frozenRows(run: Compared | undefined, evalId: string): number {
  if (!run) return 0;
  const { caseVersions, evalId: own } = run.experiment;
  return own === evalId
    ? caseVersions.length
    : caseVersions.filter((frozen) => frozen.evalId === evalId).length;
}
