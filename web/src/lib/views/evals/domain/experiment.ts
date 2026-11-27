import type { CaseVersion, EvalCase } from "./case";
import type { FrozenDataset } from "./dataset";
import type { EvalScorerRef, FrozenEval } from "./eval";
import { combinationKey, type Matrix, type MatrixValue } from "./matrix";
import type { ScorerResult, ScorerSnapshot, TrialResult } from "./score";

export const DEFAULT_TRIALS = 3;
export const MAX_TRIALS = 20;
export const MAX_EXPERIMENT_TRIALS = 5_000;

export type ExperimentState = "running" | "completed";
/** `starting` and `scoring` are claims of one process. Only `done` has a result. */
export type TrialState = "pending" | "starting" | "running" | "scoring" | "done";

/**
 * A row as an experiment freezes it. A run from before evals had definitions has no `evalId`. A row
 * of a fixed dataset is a case version. A row that the run resolved from a query, or added for
 * itself, is a run row (`row: "run"`): its `caseId` is the turn that it copies, else its own id, so
 * the same turn in two runs is the same case.
 */
export type FrozenCase = {
  caseId: string;
  versionId: string;
  number: number;
  name: string;
  evalId?: string;
  /** Where its content is. Absent: a case version. */
  row?: "case" | "run";
};

/** One combination of the matrix of a run: the values of the matrix, and all the params of it. */
export type Variant = {
  index: number;
  /** The values of the matrix params. Empty with no matrix. */
  values: Record<string, MatrixValue>;
  /** The params that each trial of the variant gets. */
  params: Record<string, unknown>;
};

/** What a run changed for itself only (decision `runs-per-eval`). The eval does not change. */
export type RunChanges = {
  datasetId?: string;
  /** The number of rows that the run added for itself. */
  extraRows?: number;
  scorers?: EvalScorerRef[];
  sandboxVersionId?: string;
  params?: Record<string, unknown>;
  matrix?: Matrix;
  trials?: number;
};

/** What an experiment is. Nothing but the state and the end changes after the start. */
export type Experiment = {
  id: string;
  projectId: string;
  organizationId: string;
  /** The eval of the run. Null for a suite run from before runs had one eval. */
  evalId: string | null;
  sandboxVersionId: string;
  sandboxName: string;
  /** The name that the person gave the run. Null when it has none. */
  name: string | null;
  /** The label that chose the cases. Null: all cases. */
  labelFilter: string | null;
  gitCommit: string;
  gitDirty: boolean;
  params: Record<string, unknown>;
  trialsPerCase: number;
  caseVersions: FrozenCase[];
  /** The eval versions that the run froze. Empty for a run from before evals had definitions. */
  evalVersions: FrozenEval[];
  /** The frozen scorers of each case version (the scorers of its eval version), by its id. */
  scorerSnapshots: Record<string, ScorerSnapshot[]>;
  /** The dataset as the run used it. Null for a run from before datasets. */
  dataset: FrozenDataset | null;
  /** One for each combination of the matrix. Empty for a run from before: one variant of `params`. */
  variants: Variant[];
  changes: RunChanges;
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
  /** The index of its variant. 0 with no matrix. */
  variant: number;
  state: TrialState;
  result: TrialResult | null;
  /** Why it is invalid, or the error of the agent. */
  reason: string | null;
  scorers: ScorerResult[];
  costUsd: number | null;
  durationMs: number | null;
  traceId: string | null;
  sandboxRunId: string | null;
};

/** What the agent did in a trial. It can be large, so it is read for one trial at a time. */
export type TrialEvidence = { output: unknown; toolCalls: TrialToolCall[] };

export type TrialOutcome = TrialEvidence &
  Pick<Trial, "reason" | "scorers"> & {
    result: TrialResult;
    costUsd: number | null;
    durationMs: number | null;
    traceId: string | null;
    /** Set when the run started and the trial did not become running. */
    sandboxRunId?: string;
  };

export type Counts = { pass: number; fail: number; invalid: number; open: number };

export type FrozenSuite = Pick<Experiment, "caseVersions" | "evalVersions" | "scorerSnapshots">;

/** The current version of each case, with a label only the cases that have it. */
export function rowsOf(
  cases: readonly EvalCase[],
  label: string | null,
): Array<{ evalCase: EvalCase; caseVersion: CaseVersion }> {
  return cases.flatMap((evalCase) => {
    if (label !== null && !evalCase.labels.includes(label)) return [];
    const caseVersion = evalCase.versions[0];
    return caseVersion ? [{ evalCase, caseVersion }] : [];
  });
}

export function frozenCase(evalCase: EvalCase, version: CaseVersion, evalId: string): FrozenCase {
  return {
    caseId: evalCase.id,
    versionId: version.id,
    number: version.number,
    name: evalCase.name,
    evalId,
  };
}

/** The variants of a run: each run param the same in each. With no variant (a run from before), one. */
export function variantsOf(
  experiment: Pick<Experiment, "variants" | "params">,
): Variant[] {
  return experiment.variants.length > 0
    ? experiment.variants
    : [{ index: 0, values: {}, params: experiment.params }];
}

/** The variant of the other run with the same values of the matrix, or null. */
export function sameVariant(variant: Variant, other: readonly Variant[]): Variant | null {
  const key = combinationKey(variant.values);
  return other.find((one) => combinationKey(one.values) === key) ?? null;
}

/** The frozen eval of a case version. Null for a run from before evals had definitions. */
export function evalOfVersion(
  experiment: Pick<Experiment, "caseVersions" | "evalVersions">,
  caseVersionId: string,
): FrozenEval | null {
  const evalId = experiment.caseVersions.find(
    ({ versionId }) => versionId === caseVersionId,
  )?.evalId;
  return experiment.evalVersions.find((frozen) => frozen.evalId === evalId) ?? null;
}

/** The trials of a case in one variant: the trials of its eval, else the trials of the run. */
export function trialsOfCase(
  experiment: Pick<Experiment, "caseVersions" | "evalVersions" | "trialsPerCase">,
  frozen: FrozenCase,
): number {
  return (
    experiment.evalVersions.find(({ evalId }) => evalId === frozen.evalId)?.trials ??
    experiment.trialsPerCase
  );
}

/**
 * The params of a trial: the params of its variant; else the params of its eval with the run's
 * over them; else the run's.
 */
export function paramsOfTrial(
  experiment: Pick<Experiment, "caseVersions" | "evalVersions" | "params" | "variants">,
  caseVersionId: string,
  variant = 0,
): Record<string, unknown> {
  const own = experiment.variants.find(({ index }) => index === variant);
  if (own) return own.params;
  return evalOfVersion(experiment, caseVersionId)?.params ?? experiment.params;
}

export function emptyCounts(): Counts {
  return { pass: 0, fail: 0, invalid: 0, open: 0 };
}

export function countTrials(trials: ReadonlyArray<Pick<Trial, "result">>): Counts {
  const counts = emptyCounts();
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
