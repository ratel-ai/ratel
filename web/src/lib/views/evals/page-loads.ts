import { z } from "zod";
import { getDb } from "@/lib/platform/db/client";
import { createDrizzleBaselineStore } from "./adapters/drizzle-baseline-store";
import { createDrizzleExperimentStore } from "./adapters/drizzle-experiment-store";
import type { Compared } from "./baseline";
import { emptyCounts } from "./domain/experiment";
import { type ExperimentRow, experimentRow } from "./page-model";
import type { Baseline } from "./ports/baseline-store";

const RUNS = 20;

export type LoadedRuns = {
  /** The newest first. */
  runs: ExperimentRow[];
  /** The asked run, else the newest. Null when the project has no run. */
  run: Compared | null;
  /** The pinned baseline run. Null when none is pinned. */
  baseline: Compared | null;
  pin: Baseline | null;
};

/** The runs of the project for the selector, the asked run and the pinned baseline, with trials. */
export async function loadRuns(projectId: string, runId: string | null): Promise<LoadedRuns> {
  const db = getDb();
  const store = createDrizzleExperimentStore(db);
  const [rows, pin] = await Promise.all([
    store.list(projectId, RUNS),
    createDrizzleBaselineStore(db).get(projectId),
  ]);
  const counts = await store.counts(rows.map(({ id }) => id));
  const asked = runId && z.uuid().safeParse(runId).success ? runId : null;
  const runOf = async (id: string | null): Promise<Compared | null> => {
    const experiment = id ? await store.get(projectId, id) : null;
    return experiment ? { experiment, trials: await store.trials(experiment.id) } : null;
  };
  const [run, baseline] = await Promise.all([
    runOf(asked ?? rows[0]?.id ?? null),
    runOf(pin?.experimentId ?? null),
  ]);
  return {
    runs: rows.map((row) => experimentRow(row, counts.get(row.id) ?? emptyCounts())),
    run,
    baseline,
    pin,
  };
}
