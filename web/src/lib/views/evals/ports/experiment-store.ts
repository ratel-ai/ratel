import type { CaseVersion } from "../domain/case";
import type { Counts, Experiment, Trial, TrialEvidence, TrialOutcome } from "../domain/experiment";

export type NewExperiment = Omit<Experiment, "id" | "state" | "createdAt" | "finishedAt">;

/** An experiment never changes, except that it ends. A trial that is done never changes. */
export interface ExperimentStore {
  /** Adds the experiment and its trials, all `pending`. Null: the project has `maxRunning` already. */
  create(input: NewExperiment, maxRunning: number): Promise<Experiment | null>;
  get(projectId: string, experimentId: string): Promise<Experiment | null>;
  /** The newest first. */
  list(projectId: string, limit: number): Promise<Experiment[]>;
  counts(experimentIds: readonly string[]): Promise<Map<string, Counts>>;
  /** In the order of the cases, then of the index. With no output and no tool calls. */
  trials(experimentId: string): Promise<Trial[]>;
  trialEvidence(projectId: string, trialId: string): Promise<TrialEvidence | null>;
  /** Some of the running experiments. Each call mixes them, so none waits for an older one. */
  listRunning(limit: number): Promise<Experiment[]>;
  caseVersion(versionId: string): Promise<CaseVersion | null>;

  /** `pending` to `starting`, while at most `open` trials of the project are open. */
  claimStarts(
    experiment: Pick<Experiment, "id" | "projectId">,
    open: number,
    now: Date,
  ): Promise<Trial[]>;
  /** `starting` to `running`. */
  markRunning(trialId: string, sandboxRunId: string): Promise<void>;
  listRunningTrials(experimentId: string, limit: number): Promise<Trial[]>;
  /** `running` to `scoring`. False when another process has it. */
  claimScoring(trialId: string, now: Date): Promise<boolean>;
  /** Ends a trial that is not done. */
  finish(trialId: string, outcome: TrialOutcome): Promise<void>;
  /** The scorings that a process left: `scoring` to `running`. */
  releaseStoppedScorings(experimentId: string, before: Date): Promise<void>;
  /** Ends the starts that a process left. Returns their number. */
  endStoppedStarts(experimentId: string, before: Date, outcome: TrialOutcome): Promise<number>;
  /** Closes an experiment with no open trial. True one time. */
  close(experimentId: string, now: Date): Promise<boolean>;
}
