import type { Compared } from "./baseline";
import type { DatasetQuery } from "./domain/dataset";
import { currentVersion, datasetOf, type EvalDefinition } from "./domain/eval";
import type { RunChanges, Variant } from "./domain/experiment";
import {
  type EvalDelta,
  evalDeltas,
  evalScores,
  RUN_SCORE_RULE,
  runDelta,
  runScore,
} from "./domain/suite";
import type { DatasetSummary } from "./ports/dataset-store";

/**
 * The read models of the score history (decision `runs-per-eval`): the Evals overview, one eval
 * with its runs, and the list of datasets. Plain data: the pages, the API and the MCP operations
 * show it. A run of one eval scores as `RUN_SCORE_RULE` says. A suite run from before scores each
 * of its evals as the suite table does. Each chart series is in the order of the run time.
 */

export type SeriesPoint = { experimentId: string; at: string; score: number | null };

export type EvalOverviewRow = {
  evalId: string;
  name: string;
  cases: number;
  scorers: number;
  /** The score of the pinned baseline run of the eval. Null with no pin, or no score. */
  baselineScore: number | null;
  /** The score of the newest completed run. */
  newestScore: number | null;
  /** One point for each completed run, the oldest first. */
  series: SeriesPoint[];
};

export type EvalRunRow = {
  experimentId: string;
  /** The name that the person gave the run. Null: none. */
  name: string | null;
  at: string;
  state: "running" | "completed";
  datasetId: string | null;
  /** The rows that the run froze. */
  rows: number;
  sandboxVersionId: string;
  sandboxName: string;
  gitCommit: string;
  scorers: string[];
  params: Record<string, unknown>;
  variants: Variant[];
  score: number | null;
  /** Null with no baseline, for the baseline itself, and with a refusal. */
  delta: { score: number | null } | null;
  deltaRefusal: { reason: string; message: string } | null;
  isBaseline: boolean;
  /** The trials that no gating scorer could score. */
  invalid: number;
  /** What the run changed for itself only. */
  changes: RunChanges;
};

export type ScorerSeries = {
  scorerId: string;
  name: string;
  gating: boolean;
  /** The pass rate of the scorer in each completed run that has it, the oldest first. */
  points: Array<{ experimentId: string; at: string; passRate: number | null }>;
};

export type EvalHistory = {
  evalId: string;
  name: string;
  datasetId: string;
  baselineId: string | null;
  rule: string;
  /** The newest first. */
  runs: EvalRunRow[];
  scorerSeries: ScorerSeries[];
};

export type DatasetRow = {
  datasetId: string;
  name: string;
  description: string | null;
  kind: DatasetQuery["kind"];
  /** The rows of a fixed dataset. Null for a query kind. */
  rows: number | null;
  /** What a query kind resolves, in words, or its RQL text. Null for a fixed dataset. */
  query: string | null;
  updatedAt: string;
  /** The evals whose newest version reads the dataset. */
  evals: Array<{ evalId: string; name: string }>;
};

export function evalsOverview({
  evals,
  rowCounts,
  runs,
  baselines,
}: {
  evals: readonly EvalDefinition[];
  /** The rows of each dataset, by its id. */
  rowCounts: ReadonlyMap<string, number>;
  runs: readonly Compared[];
  /** The pinned baseline run of each eval, by the eval id. */
  baselines: ReadonlyMap<string, string>;
}): EvalOverviewRow[] {
  return evals.map((definition) => {
    const scored = scoredRuns(definition.id, runs);
    const series = scored
      .filter(({ run }) => run.experiment.state === "completed")
      .map(({ run, score }) => point(run, score));
    const baselineId = baselines.get(definition.id);
    return {
      evalId: definition.id,
      name: definition.name,
      cases: rowCounts.get(datasetOf(definition)) ?? 0,
      scorers: currentVersion(definition).scorers.length,
      baselineScore: scored.find(({ run }) => run.experiment.id === baselineId)?.score ?? null,
      newestScore: series.at(-1)?.score ?? null,
      series,
    };
  });
}

export function evalHistory({
  definition,
  runs,
  baseline,
}: {
  definition: EvalDefinition;
  runs: readonly Compared[];
  /** The pinned baseline run of the eval. */
  baseline: Compared | null;
}): EvalHistory {
  const scored = scoredRuns(definition.id, runs);
  const rows = scored.map(({ run, score }) => runRow(definition.id, run, score, baseline));
  return {
    evalId: definition.id,
    name: definition.name,
    datasetId: datasetOf(definition),
    baselineId: baseline?.experiment.id ?? null,
    rule: RUN_SCORE_RULE,
    runs: rows.reverse(),
    scorerSeries: scorerSeries(definition.id, scored),
  };
}

export function datasetsView(
  datasets: readonly DatasetSummary[],
  evals: readonly EvalDefinition[],
): DatasetRow[] {
  const byDataset = Map.groupBy(evals, datasetOf);
  return datasets.map((dataset) => ({
    datasetId: dataset.id,
    name: dataset.name,
    description: dataset.description,
    kind: dataset.query.kind,
    rows: dataset.query.kind === "fixed" ? dataset.rowCount : null,
    query: queryText(dataset.query),
    updatedAt: dataset.updatedAt.toISOString(),
    evals: (byDataset.get(dataset.id) ?? []).map(({ id, name }) => ({ evalId: id, name })),
  }));
}

/**
 * The runs with each pinned baseline run that they do not have: a pin can be older than the newest
 * runs that a history reads.
 */
export async function withPinnedRuns(
  runs: readonly Compared[],
  pins: ReadonlyArray<string | null | undefined>,
  load: (experimentId: string) => Promise<Compared | null>,
): Promise<Compared[]> {
  const have = new Set(runs.map(({ experiment }) => experiment.id));
  const missing = [...new Set(pins.flatMap((pin) => (pin && !have.has(pin) ? [pin] : [])))];
  const loaded = await Promise.all(missing.map(load));
  return [...runs, ...loaded.filter((run) => run !== null)];
}

/** What a query kind resolves, in words. */
export function queryText(query: DatasetQuery): string | null {
  switch (query.kind) {
    case "fixed":
      return null;
    case "last_traces":
      return `The last ${query.limit} traces`;
    case "task_traces":
      return `The last ${query.limit} traces of the task ${query.taskId}`;
    case "rql":
      return query.text;
    case "auto":
      return query.taskId === null
        ? `Ratel chooses ${query.limit} traces`
        : `Ratel chooses ${query.limit} traces of the task ${query.taskId}`;
  }
}

type Scored = { run: Compared; score: number | null };

/** The runs that have the eval, with its score in each, the oldest first. */
function scoredRuns(evalId: string, runs: readonly Compared[]): Scored[] {
  return [...runs]
    .sort((a, b) => a.experiment.createdAt.getTime() - b.experiment.createdAt.getTime())
    .flatMap((run) => {
      if (run.experiment.evalId === evalId) return [{ run, score: runScore(run).score }];
      if (run.experiment.evalId !== null) return [];
      const ofEval = evalScores(run).find((score) => score.evalId === evalId);
      return ofEval ? [{ run, score: ofEval.score }] : [];
    });
}

function runRow(
  evalId: string,
  run: Compared,
  score: number | null,
  baseline: Compared | null,
): EvalRunRow {
  const { experiment } = run;
  const isBaseline = baseline?.experiment.id === experiment.id;
  const delta = baseline && !isBaseline ? deltaOf(evalId, baseline, run) : null;
  return {
    experimentId: experiment.id,
    name: experiment.name,
    at: experiment.createdAt.toISOString(),
    state: experiment.state,
    datasetId: experiment.datasetId,
    rows: experiment.caseVersions.length,
    sandboxVersionId: experiment.sandboxVersionId,
    sandboxName: experiment.sandboxName,
    gitCommit: experiment.gitCommit,
    scorers: (evalScores(run).find((one) => one.evalId === evalId)?.scorers ?? []).map(
      ({ name }) => name,
    ),
    params: experiment.params,
    variants: experiment.variants,
    score,
    delta: delta?.ok ? { score: delta.score } : null,
    deltaRefusal: delta && !delta.ok ? { reason: delta.reason, message: delta.message } : null,
    isBaseline,
    invalid: run.trials.filter(({ result }) => result === "invalid").length,
    changes: experiment.changes,
  };
}

function deltaOf(evalId: string, baseline: Compared, run: Compared): EvalDelta | undefined {
  if (run.experiment.evalId === evalId && baseline.experiment.evalId === evalId) {
    return runDelta(baseline, run);
  }
  return evalDeltas(baseline, run).get(evalId);
}

/** One series for each scorer id of the eval, in the order that the scorers first appear. */
function scorerSeries(evalId: string, scored: readonly Scored[]): ScorerSeries[] {
  const series = new Map<string, ScorerSeries>();
  for (const { run } of scored) {
    if (run.experiment.state !== "completed") continue;
    const score = evalScores(run).find((one) => one.evalId === evalId);
    for (const scorer of score?.scorers ?? []) {
      const one = series.get(scorer.scorerId) ?? {
        scorerId: scorer.scorerId,
        name: scorer.name,
        gating: scorer.gating,
        points: [],
      };
      one.points.push({
        experimentId: run.experiment.id,
        at: run.experiment.createdAt.toISOString(),
        passRate: scorer.passRate,
      });
      series.set(scorer.scorerId, one);
    }
  }
  return [...series.values()];
}

function point({ experiment }: Compared, score: number | null): SeriesPoint {
  return { experimentId: experiment.id, at: experiment.createdAt.toISOString(), score };
}
