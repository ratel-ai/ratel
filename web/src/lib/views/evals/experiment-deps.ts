import { after } from "next/server";
import { getDb } from "@/lib/platform/db/client";
import { withProjectLogContext } from "@/lib/platform/project-log-context";
import { publicUrl } from "@/lib/platform/public-url";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { contentOptIn } from "@/lib/views/session-replay/runs";
import {
  getRun,
  getSandboxVersion,
  listSandboxVersions,
  sandboxesEnabledForProject,
  startRun,
} from "@/lib/views/sandboxes";
import { listScorers } from "@/lib/views/scorers/store";
import { createDrizzleCaseStore } from "./adapters/drizzle-case-store";
import { createDrizzleDatasetStore } from "./adapters/drizzle-dataset-store";
import { createDrizzleEvalStore } from "./adapters/drizzle-eval-store";
import { createDrizzleExperimentStore } from "./adapters/drizzle-experiment-store";
import { createTraceSource } from "./adapters/trace-source";
import { pinnedRun } from "./baseline";
import { baselineDeps } from "./baseline-deps";
import { evalsAccess, readOnlyTools } from "./console-deps";
import type { Experiment } from "./domain/experiment";
import { advanceExperiment, type ExperimentDeps } from "./experiments";
import type { ConsoleDeps, ExperimentsApiDeps } from "./experiments-api";
import type { ConsoleApiDeps } from "./console-api";
import { caseFromTurn } from "./domain/from-turn";
import { judgeDeps } from "./judge-deps";
import { loadTurnContent } from "./turn-content";

/** Experiments over the real database, sandboxes and judge. */
export function experimentDeps(): ExperimentDeps {
  const db = getDb();
  return {
    experiments: createDrizzleExperimentStore(db),
    cases: createDrizzleCaseStore(db),
    evals: createDrizzleEvalStore(db),
    datasets: createDrizzleDatasetStore(db),
    traces: createTraceSource(db, { readOnlyTools, now: () => new Date() }),
    library: { projectScorers: (projectId) => listScorers(projectId, db) },
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
  baseline: (projectId, evalId) => pinnedRun(projectId, baselineDeps(), evalId),
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

/** The session routes of the Datasets and Evals pages, over the real stores and session. */
export const consoleApiDeps: ConsoleApiDeps = {
  ...evalsAccess,
  actions: () => ({
    ...experimentDeps(),
    datasets: createDrizzleDatasetStore(getDb()),
    evals: createDrizzleEvalStore(getDb()),
    turnRow,
  }),
  readContent: (projectId) => contentOptIn(projectId),
  advance: experimentsApiDeps.advance,
  track: (event, { externalId, projectId, organizationId }, fields) =>
    trackServerEvent(
      event,
      { externalId, projectId, orgId: organizationId },
      { object_action: event, surface: "console", ...fields },
    ),
  now: () => new Date(),
};

/** A row from a trace turn of the project: its frozen input, earlier messages and fixtures. */
export async function turnRow(projectId: string, turnId: string) {
  const turn = await loadTurnContent(projectId, turnId);
  return turn ? caseFromTurn(turn, await readOnlyTools(projectId)) : null;
}
