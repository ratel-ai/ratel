import type { Compared } from "./baseline";
import { type Dataset, type DatasetKind, querySummary } from "./domain/dataset";
import { currentVersion, type EvalDefinition } from "./domain/eval";
import type { Counts, RunChanges } from "./domain/experiment";
import { type Delta, type RunScore, runScore, type VariantScore } from "./domain/history";

/**
 * The read models of the evals pages and of the API (decision `runs-per-eval`): the overview of
 * the evals with a score series, one eval with its runs and a series for each scorer, and the list
 * of datasets. Plain data: the pages, the API and the MCP operations show it. Each series is in the
 * order of run time (the start of the run), the oldest first.
 */

/** The rule of each score of these models, in words. */
export const SCORE_RULE =
  "The score of a variant is the mean pass rate of its scorers over its valid trials. The score of a run is the mean of the scores of its variants. A run with no matrix has one variant.";

export type ScorePoint = { runId: string; at: string; score: number | null };

export type EvalOverviewRow = {
  evalId: string;
  name: string;
  taskId: string | null;
  datasetId: string | null;
  datasetName: string | null;
  datasetKind: DatasetKind | null;
  /** The rows of a fixed dataset. Null for a query dataset: a run resolves its rows. */
  cases: number | null;
  /** What a query dataset reads. Null for a fixed dataset. */
  query: string | null;
  scorers: number;
  sandboxName: string | null;
  baselineRunId: string | null;
  baselineScore: number | null;
  newestRunId: string | null;
  newestState: "running" | "completed" | null;
  newestScore: number | null;
  /** The score of each run, the oldest first. */
  series: ScorePoint[];
};

export type EvalsOverview = { scoreRule: string; evals: EvalOverviewRow[] };

/** Each eval with its rows, its scorers, its baseline score, its newest score and its series. */
export function evalsOverview({
  evals,
  datasets,
  rowCounts,
  runs,
  baselines,
}: {
  evals: readonly EvalDefinition[];
  datasets: readonly Dataset[];
  rowCounts: ReadonlyMap<string, number>;
  /** The runs of each eval, by its id, in any order. */
  runs: ReadonlyMap<string, readonly Compared[]>;
  /** The pinned baseline run of each eval, by its id. */
  baselines: ReadonlyMap<string, string>;
}): EvalsOverview {
  const byId = new Map(datasets.map((dataset) => [dataset.id, dataset]));
  return {
    scoreRule: SCORE_RULE,
    evals: evals.map((definition): EvalOverviewRow => {
      const version = currentVersion(definition);
      const dataset = version.datasetId ? (byId.get(version.datasetId) ?? null) : null;
      const fixed = dataset?.definition.kind === "fixed";
      const scored = byTime(runs.get(definition.id) ?? []).map((run) => ({
        run,
        score: runScore(run, definition.id),
      }));
      const newest = scored.at(-1) ?? null;
      const baselineRunId = baselines.get(definition.id) ?? null;
      const baseline = scored.find(({ run }) => run.experiment.id === baselineRunId) ?? null;
      return {
        evalId: definition.id,
        name: definition.name,
        taskId: definition.taskId,
        datasetId: dataset?.id ?? null,
        datasetName: dataset?.name ?? null,
        datasetKind: dataset?.definition.kind ?? null,
        cases: dataset && fixed ? (rowCounts.get(dataset.id) ?? 0) : null,
        query: dataset ? querySummary(dataset.definition) : null,
        scorers: version.scorers.length,
        sandboxName: version.sandboxName,
        baselineRunId,
        baselineScore: baseline?.score?.score ?? null,
        newestRunId: newest?.run.experiment.id ?? null,
        newestState: newest?.run.experiment.state ?? null,
        newestScore: newest?.score?.score ?? null,
        series: scored.map(({ run, score }) => ({
          runId: run.experiment.id,
          at: run.experiment.createdAt.toISOString(),
          score: score?.score ?? null,
        })),
      };
    }),
  };
}

export type EvalRunRow = {
  runId: string;
  state: "running" | "completed";
  createdAt: string;
  name: string | null;
  /** A suite run from before runs had one eval: the eval was one of its evals. */
  suite: boolean;
  /** The eval version that the run froze. */
  version: number | null;
  dataset: { datasetId: string; name: string; kind: DatasetKind; rows: number } | null;
  runtime: { sandboxName: string; sandboxVersionId: string; gitCommit: string };
  scorers: Array<{ scorerId: string; name: string; gating: boolean }>;
  params: Record<string, unknown>;
  changes: RunChanges;
  counts: Counts;
  score: number | null;
  /** Against the pinned baseline of the eval. Null with none, or for the baseline itself. */
  delta: Delta | null;
  variants: VariantScore[];
  baseline: boolean;
};

export type ScorerSeries = {
  /** The content of the scorer: a scorer whose content changed is another series. */
  key: string;
  name: string;
  points: Array<{ runId: string; at: string; passRate: number | null }>;
};

export type EvalRunsView = {
  evalId: string;
  name: string;
  scoreRule: string;
  baselineRunId: string | null;
  /** The newest first. */
  runs: EvalRunRow[];
  /** The pass rate of each scorer in each run, the oldest run first. */
  scorerSeries: ScorerSeries[];
};

/** One eval: its runs with their dataset, runtime, scorers, params, score and delta. */
export function evalRunsView(
  definition: Pick<EvalDefinition, "id" | "name">,
  runs: readonly Compared[],
  baseline: Compared | null,
): EvalRunsView {
  const ordered = byTime(runs);
  const scored = ordered.flatMap((run) => {
    const score = runScore(run, definition.id, baseline);
    return score ? [{ run, score }] : [];
  });
  const series = new Map<string, ScorerSeries>();
  for (const { run, score } of scored) {
    for (const scorer of score.scorers) {
      const key = scorer.hash || `name:${scorer.name}`;
      const one = series.get(key) ?? { key, name: scorer.name, points: [] };
      one.points.push({
        runId: run.experiment.id,
        at: run.experiment.createdAt.toISOString(),
        passRate: scorer.passRate,
      });
      series.set(key, one);
    }
  }
  return {
    evalId: definition.id,
    name: definition.name,
    scoreRule: SCORE_RULE,
    baselineRunId: baseline?.experiment.id ?? null,
    runs: scored
      .map(({ run, score }) => runRow(definition.id, run, score, baseline))
      .reverse(),
    scorerSeries: [...series.values()],
  };
}

function runRow(
  evalId: string,
  { experiment }: Compared,
  score: RunScore,
  baseline: Compared | null,
): EvalRunRow {
  const frozen = experiment.evalVersions.find((one) => one.evalId === evalId);
  const { dataset } = experiment;
  return {
    runId: experiment.id,
    state: experiment.state,
    createdAt: experiment.createdAt.toISOString(),
    name: experiment.name,
    suite: experiment.evalId === null,
    version: frozen?.number ?? null,
    dataset: dataset && {
      datasetId: dataset.datasetId,
      name: dataset.name,
      kind: dataset.kind,
      rows: dataset.rows,
    },
    runtime: {
      sandboxName: experiment.sandboxName,
      sandboxVersionId: experiment.sandboxVersionId,
      gitCommit: experiment.gitCommit,
    },
    scorers: score.scorers.map(({ scorerId, name, gating }) => ({ scorerId, name, gating })),
    params: frozen?.params ?? experiment.params,
    changes: experiment.changes,
    counts: score.counts,
    score: score.score,
    delta: score.delta,
    variants: score.variants,
    baseline: baseline?.experiment.id === experiment.id,
  };
}

export type DatasetListRow = {
  datasetId: string;
  name: string;
  kind: DatasetKind;
  /** The rows of a fixed dataset. Null for a query dataset. */
  rows: number | null;
  /** What a query dataset reads. Null for a fixed dataset. */
  query: string | null;
  updatedAt: string;
  /** The evals whose newest version uses the dataset. */
  evals: Array<{ evalId: string; name: string }>;
};

/** Each dataset with its kind, its rows or its query, its update time and the evals that use it. */
export function datasetsList(
  datasets: readonly Dataset[],
  rowStats: ReadonlyMap<string, { rows: number; lastAddedAt: Date | null }>,
  evals: readonly EvalDefinition[],
): DatasetListRow[] {
  return datasets.map((dataset) => {
    const stats = rowStats.get(dataset.id);
    const fixed = dataset.definition.kind === "fixed";
    const updated =
      stats?.lastAddedAt && stats.lastAddedAt > dataset.updatedAt
        ? stats.lastAddedAt
        : dataset.updatedAt;
    return {
      datasetId: dataset.id,
      name: dataset.name,
      kind: dataset.definition.kind,
      rows: fixed ? (stats?.rows ?? 0) : null,
      query: querySummary(dataset.definition),
      updatedAt: updated.toISOString(),
      evals: evals
        .filter((one) => currentVersion(one).datasetId === dataset.id)
        .map(({ id, name }) => ({ evalId: id, name })),
    };
  });
}

/** The oldest run first; two runs of the same time in the order of their ids. */
function byTime(runs: readonly Compared[]): Compared[] {
  return [...runs].sort(
    (left, right) =>
      left.experiment.createdAt.getTime() - right.experiment.createdAt.getTime() ||
      (left.experiment.id < right.experiment.id ? -1 : 1),
  );
}
