import type { CaseVersion, EvalCase } from "./case";
import { approvedVersion } from "./case";
import { type ScorerResult, type ScorerSnapshot, snapshotOf, type TrialResult } from "./score";

export const DEFAULT_TRIALS = 3;
export const MAX_TRIALS = 20;
export const MAX_EXPERIMENT_TRIALS = 5_000;

export type ExperimentState = "running" | "completed";
/** `starting` and `scoring` are claims of one process. Only `done` has a result. */
export type TrialState = "pending" | "starting" | "running" | "scoring" | "done";

/** A case version as an experiment freezes it. */
export type FrozenCase = { caseId: string; versionId: string; number: number; name: string };

/** What an experiment is. Nothing but the state and the end changes after the start. */
export type Experiment = {
  id: string;
  projectId: string;
  organizationId: string;
  sandboxVersionId: string;
  sandboxName: string;
  gitCommit: string;
  gitDirty: boolean;
  params: Record<string, unknown>;
  trialsPerCase: number;
  caseVersions: FrozenCase[];
  /** The frozen scorers of each case version, by its id. */
  scorerSnapshots: Record<string, ScorerSnapshot[]>;
  startedBy: string;
  state: ExperimentState;
  createdAt: Date;
  finishedAt: Date | null;
};

export type TrialToolCall = {
  name: string;
  arguments: unknown;
  result?: unknown;
  error?: string;
  source: "real" | "fixture" | "fake";
};

export type Trial = {
  id: string;
  experimentId: string;
  caseVersionId: string;
  index: number;
  state: TrialState;
  result: TrialResult | null;
  /** Why it is invalid, or the error of the agent. */
  reason: string | null;
  output: unknown;
  toolCalls: TrialToolCall[];
  scorers: ScorerResult[];
  costUsd: number | null;
  durationMs: number | null;
  traceId: string | null;
  sandboxRunId: string | null;
};

export type TrialOutcome = Pick<Trial, "reason" | "output" | "toolCalls" | "scorers"> & {
  result: TrialResult;
  costUsd: number | null;
  durationMs: number | null;
  traceId: string | null;
};

export type Counts = { pass: number; fail: number; invalid: number; open: number };

/** The approved version of each case, and no draft. */
export function freezeCases(cases: readonly EvalCase[]): {
  caseVersions: FrozenCase[];
  scorerSnapshots: Record<string, ScorerSnapshot[]>;
} {
  const approved = cases.flatMap(
    (evalCase): Array<{ evalCase: EvalCase; version: CaseVersion }> => {
      const version = approvedVersion(evalCase);
      return version ? [{ evalCase, version }] : [];
    },
  );
  return {
    caseVersions: approved.map(({ evalCase, version }) => ({
      caseId: evalCase.id,
      versionId: version.id,
      number: version.number,
      name: evalCase.name,
    })),
    scorerSnapshots: Object.fromEntries(
      approved.map(({ version }) => [version.id, version.scorers.map(snapshotOf)]),
    ),
  };
}

export function countTrials(trials: ReadonlyArray<Pick<Trial, "result">>): Counts {
  const counts: Counts = { pass: 0, fail: 0, invalid: 0, open: 0 };
  for (const { result } of trials) counts[result ?? "open"] += 1;
  return counts;
}

/** An outcome of a trial that no scorer read. */
export function unscored(
  result: TrialResult,
  reason: string,
  over: Partial<TrialOutcome> = {},
): TrialOutcome {
  return {
    result,
    reason,
    output: null,
    toolCalls: [],
    scorers: [],
    costUsd: null,
    durationMs: null,
    traceId: null,
    ...over,
  };
}
