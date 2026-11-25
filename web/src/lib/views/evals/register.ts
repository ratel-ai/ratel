import type { Registration } from "@/lib/contracts/registry";
import { getLogger } from "@/lib/platform/logger";
import { advance, experimentDeps } from "./experiment-deps";

/** The experiments that one tick moves. */
const LIMIT = 50;
/** A tick takes no more trials after this: the jobs of every project wait for it. */
const STEP_MS = 20_000;

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
        const deadline = new Date(Date.now() + STEP_MS);
        for (const experiment of await deps.experiments.listRunning(LIMIT)) {
          if (new Date() > deadline) break;
          try {
            const { started, finished, closed } = await advance(experiment, deps, deadline);
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
