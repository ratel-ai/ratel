import type { DrainStep, Registration } from "@/lib/contracts/registry";
import { createBackgroundObservability } from "@/lib/jobs/observability";
import { type SweepResult, sweepScorers } from "./sweep";
import "./metrics";
import "./spend";

type TrackSystemEvent = ReturnType<typeof createBackgroundObservability>["trackSystemEvent"];

/** Scores the newly settled traces: after `trace_summary_refresh`, which runs in registration order. */
export function scorerSweepStep(
  sweep: () => Promise<SweepResult> = () => sweepScorers(),
  track: TrackSystemEvent = createBackgroundObservability().trackSystemEvent,
): DrainStep {
  return {
    name: "scorers_sweep",
    phase: "after",
    run: async () => {
      const result = await sweep();
      if (result.tracesScanned > 0 || result.failedScorers > 0) {
        await track("feature.scorers.swept", "system:cron", {
          scorers: result.scorers,
          traces_scanned: result.tracesScanned,
          scores_written: result.scoresWritten,
          skipped: result.skipped,
          failed_scorers: result.failedScorers,
          caught_up: result.caughtUp,
          lock_contended: result.lockContended,
        });
      }
      for (const skip of result.budgetSkips) {
        await track("feature.scorers.judge_skipped", "system:cron", {
          project_id: skip.projectId,
          scorer_id: skip.scorerId,
          traces: skip.traces,
          reason: "budget_spent",
        });
      }
      return {
        scorerTracesScanned: result.tracesScanned,
        scorerScoresWritten: result.scoresWritten,
        scorersCaughtUp: result.caughtUp,
      };
    },
  };
}

/** The scorers' registration. Loads the judge's spend reader, so every budget check counts it, and the metric source. */
export const scorersRegistration: Registration = {
  drainSteps: [scorerSweepStep()],
};
