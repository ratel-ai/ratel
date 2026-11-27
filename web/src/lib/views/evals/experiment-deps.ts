import { after } from "next/server";
import { getDb } from "@/lib/platform/db/client";
import { withProjectLogContext } from "@/lib/platform/project-log-context";
import { publicUrl } from "@/lib/platform/public-url";
import { trackServerEvent } from "@/lib/platform/telemetry";
import {
  getRun,
  getSandboxVersion,
  listSandboxVersions,
  sandboxesEnabledForProject,
  startRun,
} from "@/lib/views/sandboxes";
import { createDrizzleCaseStore } from "./adapters/drizzle-case-store";
import { createDrizzleEvalStore } from "./adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "./adapters/drizzle-experiment-store";
import { pinnedRun } from "./baseline";
import { baselineDeps } from "./baseline-deps";
import { evalsAccess } from "./console-deps";
import type { Experiment } from "./domain/experiment";
import { advanceExperiment, type ExperimentDeps } from "./experiments";
import type { ConsoleDeps, ExperimentsApiDeps } from "./experiments-api";
import { judgeDeps } from "./judge-deps";

/** Experiments over the real database, sandboxes and judge. */
export function experimentDeps(): ExperimentDeps {
  const db = getDb();
  return {
    experiments: createDrizzleExperimentStore(db),
    cases: createDrizzleCaseStore(db),
    evals: createDrizzleEvalStore(db),
    sandboxes: {
      enabled: (projectId) => sandboxesEnabledForProject(projectId),
      listVersions: listSandboxVersions,
      getVersion: getSandboxVersion,
      startRun,
      getRun,
    },
    judge: judgeDeps(),
    now: () => new Date(),
  };
}

/** One step, with the project in the log context, so each model call names it. */
export async function advance(
  experiment: Experiment,
  deps = experimentDeps(),
  deadline: Date | null = null,
) {
  const step = await withProjectLogContext(experiment.projectId, () =>
    advanceExperiment(experiment, deps, deadline),
  );
  if (step.closed) {
    await trackServerEvent(
      "eval_experiment_finished",
      { projectId: experiment.projectId, orgId: experiment.organizationId },
      { object_action: "eval_experiment_finished", cases: experiment.caseVersions.length },
    );
  }
  return step;
}

export const experimentsApiDeps: ExperimentsApiDeps = {
  experiments: experimentDeps,
  baseline: (projectId) => pinnedRun(projectId, baselineDeps()),
  advance: (experiment) =>
    after(async () => {
      await advance(experiment);
    }),
  track: ({ projectId, organizationId, caseVersions, trialsPerCase }, { externalId, surface }) =>
    trackServerEvent(
      "eval_experiment_started",
      externalId
        ? { externalId, projectId, orgId: organizationId }
        : { projectId, orgId: organizationId },
      {
        object_action: "eval_experiment_started",
        surface,
        cases: caseVersions.length,
        trials_per_case: trialsPerCase,
      },
    ),
  publicUrl,
};

export const consoleExperimentDeps: ConsoleDeps = { ...experimentsApiDeps, ...evalsAccess };
