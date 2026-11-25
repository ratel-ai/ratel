import type { Registration } from "@/lib/contracts/registry";
import { getLogger } from "@/lib/platform/logger";
import { advance, experimentDeps } from "./experiment-deps";
import { evalsEnabledForProject } from "./gate";

/** The experiments that one tick moves. */
const LIMIT = 50;

const logger = getLogger("evals/register");

/**
 * What evals contribute to the background machinery: one drain step that scores the trials whose
 * sandbox run ended, starts the next ones and closes the experiments. No worker waits for a trial.
 */
export const evalsRegistration: Registration = {
  drainSteps: [
    {
      name: "eval_experiments",
      phase: "before",
      run: async () => {
        const totals = { startedTrials: 0, finishedTrials: 0, closedExperiments: 0, evalErrors: 0 };
        const deps = experimentDeps();
        for (const experiment of await deps.experiments.listRunning(LIMIT)) {
          try {
            if (!(await evalsEnabledForProject(experiment.projectId))) continue;
            const { started, finished, closed } = await advance(experiment, deps);
            totals.startedTrials += started;
            totals.finishedTrials += finished;
            if (closed) totals.closedExperiments += 1;
          } catch (error) {
            totals.evalErrors += 1;
            logger.error(
              { project_id: experiment.projectId, experiment_id: experiment.id, err: error },
              "eval experiment step failed",
            );
          }
        }
        return totals;
      },
    },
  ],
};
