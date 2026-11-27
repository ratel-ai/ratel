import type { Compared } from "./baseline";
import type { EvalDefinition } from "./domain/eval";
import { type EvalOverviewRow, evalsOverview, withPinnedRuns } from "./history-view";
import type { BaselineStore } from "./ports/baseline-store";
import type { DatasetStore } from "./ports/dataset-store";
import type { EvalStore } from "./ports/eval-store";
import type { ExperimentStore } from "./ports/experiment-store";

/** The runs of the project that the history reads, the newest. */
export const HISTORY_RUNS = 100;

export type HistoryStores = {
  evals: Pick<EvalStore, "list">;
  datasets: Pick<DatasetStore, "list">;
  baselines: Pick<BaselineStore, "get">;
  experiments: Pick<ExperimentStore, "list" | "get" | "trials">;
};

/**
 * What the Evals overview reads: each eval, the rows of its dataset, the newest runs of the project
 * and the pinned baseline of each eval (loaded when it is older than the newest runs).
 */
export async function loadEvalsOverview(
  projectId: string,
  stores: HistoryStores,
): Promise<{ definitions: EvalDefinition[]; rows: EvalOverviewRow[] }> {
  const [definitions, summaries, recent] = await Promise.all([
    stores.evals.list(projectId),
    stores.datasets.list(projectId),
    recentRuns(projectId, stores),
  ]);
  const pins = await Promise.all(
    definitions.map(
      async ({ id }) => [id, (await stores.baselines.get(projectId, id))?.experimentId] as const,
    ),
  );
  const runs = await withPinnedRuns(
    recent,
    pins.map(([, run]) => run),
    (id) => oneRun(projectId, id, stores),
  );
  const rows = evalsOverview({
    evals: definitions,
    rowCounts: new Map(summaries.map(({ id, rowCount }) => [id, rowCount])),
    runs,
    baselines: new Map(pins.flatMap(([id, run]) => (run ? [[id, run] as const] : []))),
  });
  return { definitions, rows };
}

export async function recentRuns(
  projectId: string,
  { experiments }: Pick<HistoryStores, "experiments">,
): Promise<Compared[]> {
  const list = await experiments.list(projectId, HISTORY_RUNS);
  return Promise.all(
    list.map(async (experiment) => ({
      experiment,
      trials: await experiments.trials(experiment.id),
    })),
  );
}

export async function oneRun(
  projectId: string,
  experimentId: string,
  { experiments }: Pick<HistoryStores, "experiments">,
): Promise<Compared | null> {
  const experiment = await experiments.get(projectId, experimentId);
  return experiment ? { experiment, trials: await experiments.trials(experiment.id) } : null;
}

/**
 * A run with its trials and the pinned baseline of its eval (of the suite runs from before: the
 * suite pin). Null when the project has no such run.
 */
export async function runWithBaseline(
  projectId: string,
  experimentId: string,
  stores: Pick<HistoryStores, "experiments" | "baselines">,
): Promise<{ run: Compared; baseline: Compared | null } | null> {
  const run = await oneRun(projectId, experimentId, stores);
  if (!run) return null;
  const pin = await stores.baselines.get(projectId, run.experiment.evalId);
  const baseline =
    pin && pin.experimentId !== run.experiment.id
      ? await oneRun(projectId, pin.experimentId, stores)
      : pin
        ? run
        : null;
  return { run, baseline };
}
