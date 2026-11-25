import type { CaseVersion } from "../domain/case";
import type { Experiment, Trial, TrialOutcome } from "../domain/experiment";

export type NewExperiment = Omit<Experiment, "id" | "state" | "createdAt" | "finishedAt">;

/** An experiment never changes, except that it ends. A trial that is done never changes. */
export interface ExperimentStore {
  /** Adds the experiment and its trials, all `pending`. */
  create(input: NewExperiment): Promise<Experiment>;
  get(projectId: string, experimentId: string): Promise<Experiment | null>;
  /** The newest first. */
  list(
    projectId: string,
    limit: number,
  ): Promise<Array<{ experiment: Experiment; trials: Array<Pick<Trial, "result">> }>>;
  /** In the order of the cases, then of the index. */
  trials(experimentId: string): Promise<Trial[]>;
  listRunning(limit: number): Promise<Experiment[]>;
  caseVersion(versionId: string): Promise<CaseVersion | null>;

  /** `pending` to `starting`, while at most `open` trials of the experiment are open. */
  claimStarts(experimentId: string, open: number, now: Date): Promise<Trial[]>;
  /** `starting` to `running`. */
  markRunning(trialId: string, sandboxRunId: string): Promise<void>;
  listRunningTrials(experimentId: string, limit: number): Promise<Trial[]>;
  /** `running` to `scoring`. False when another process has it. */
  claimScoring(trialId: string, now: Date): Promise<boolean>;
  /** Ends a trial that is not done. */
  finish(trialId: string, outcome: TrialOutcome): Promise<void>;
  /** Frees the claims of a process that ended: `scoring` to `running`. Returns the left starts. */
  releaseStopped(experimentId: string, before: Date): Promise<Trial[]>;
  /** Closes an experiment with no open trial. True one time. */
  close(experimentId: string, now: Date): Promise<boolean>;
}
