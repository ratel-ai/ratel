import { getDb } from "@/lib/platform/db/client";
import { createDrizzleBaselineStore } from "./adapters/drizzle-baseline-store";
import { createDrizzleCaseStore } from "./adapters/drizzle-case-store";
import { createDrizzleDatasetStore } from "./adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "./adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "./adapters/drizzle-experiment-store";
import { createScorerLibrary } from "./adapters/scorer-library";
import type { EvalsServiceDeps } from "./evals-service";

/** The reads and writes of datasets and evals over the real database. */
export function evalsServiceDeps(): EvalsServiceDeps {
  const db = getDb();
  return {
    evals: createDrizzleEvalStore(db),
    datasets: createDrizzleDatasetStore(db),
    cases: createDrizzleCaseStore(db),
    experiments: createDrizzleExperimentStore(db),
    baselines: createDrizzleBaselineStore(db),
    library: createScorerLibrary(db),
  };
}
