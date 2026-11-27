import { type CaseVersion, currentVersion as currentRow, type EvalCase } from "./case";
import {
  currentVersion,
  type EvalDefinition,
  type EvalVersion,
  type FrozenEval,
  freezeEval,
  runProblem,
} from "./eval";
import { type ScorerResult, type ScorerSnapshot, snapshotOf, type TrialResult } from "./score";

export const DEFAULT_TRIALS = 3;
export const MAX_TRIALS = 20;
export const MAX_EXPERIMENT_TRIALS = 5_000;

export type ExperimentState = "running" | "completed";
/** `starting` and `scoring` are claims of one process. Only `done` has a result. */
export type TrialState = "pending" | "starting" | "running" | "scoring" | "done";

/** A case version as an experiment freezes it. A run from before evals had definitions has no `evalId`. */
export type FrozenCase = {
  caseId: string;
  versionId: string;
  number: number;
  name: string;
  evalId?: string;
};

/** One combination of the matrix of a run: the params of its trials, over the params of the run. */
export type Variant = { index: number; params: Record<string, unknown> };

/** What a run changed for itself only, as it was asked. The frozen fields have what it used. */
export type RunChanges = {
  datasetId?: string;
  addedRows?: number;
  scorers?: boolean;
  sandboxVersionId?: string;
  params?: Record<string, unknown>;
  matrix?: Record<string, unknown[]>;
  trials?: number;
};

/** What an experiment is. Nothing but the state and the end changes after the start. */
export type Experiment = {
  id: string;
  projectId: string;
  organizationId: string;
  /** The one eval of the run (decision `runs-per-eval`). Null for a suite run from before. */
  evalId: string | null;
  /** The dataset that the run read. Null for a suite run from before. */
  datasetId: string | null;
  /** One for each combination of the matrix. Empty: one run with `params`. */
  variants: Variant[];
  changes: RunChanges;
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
  /** The index of its variant. 0 for a run with no variant. */
  variant: number;
  index: number;
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

/**
 * Freezes the newest version of each eval that can run, and the newest version of each case of its
 * dataset (`cases` has the rows of the datasets, with the rows that a query resolved for this run):
 * each row counts (decision `rows-count-at-once`). A case version gets the scorers of its
 * eval version. An eval with no gating scorer, or with no case, is left out. With a label, only the
 * cases that have it.
 */
export function freezeSuite(
  evals: readonly EvalDefinition[],
  cases: readonly EvalCase[],
  label: string | null = null,
  run: { params?: Record<string, unknown>; trials?: number } = {},
): FrozenSuite {
  const byDataset = Map.groupBy(cases, ({ datasetId }) => datasetId);
  const frozen: FrozenSuite = { caseVersions: [], evalVersions: [], scorerSnapshots: {} };
  for (const definition of evals) {
    const version = currentVersion(definition);
    if (runProblem(version)) continue;
    const rows = rowsOf(byDataset.get(version.datasetId) ?? [], label);
    if (rows.length === 0) continue;
    frozen.evalVersions.push(freezeEval(definition, run));
    for (const { evalCase, caseVersion } of rows) {
      frozen.caseVersions.push(frozenCase(evalCase, caseVersion, definition.id));
      frozen.scorerSnapshots[caseVersion.id] = snapshotsOf(version);
    }
  }
  return frozen;
}

/**
 * Freezes one run of one eval (decision `runs-per-eval`): its version, the newest version of each
 * row that the run reads, and the scorers that the run resolved, for each row.
 */
export function freezeEvalRun(
  definition: EvalDefinition,
  rows: readonly EvalCase[],
  scorers: readonly EvalVersion["scorers"][number][],
  run: { params: Record<string, unknown>; trials: number },
): FrozenSuite {
  const frozen: FrozenSuite = {
    caseVersions: [],
    evalVersions: [freezeEval(definition, run)],
    scorerSnapshots: {},
  };
  const snapshots = scorers.map(snapshotOf);
  for (const { evalCase, caseVersion } of rowsOf(rows, null)) {
    frozen.caseVersions.push(frozenCase(evalCase, caseVersion, definition.id));
    frozen.scorerSnapshots[caseVersion.id] = snapshots;
  }
  return frozen;
}

function rowsOf(
  cases: readonly EvalCase[],
  label: string | null,
): Array<{ evalCase: EvalCase; caseVersion: CaseVersion }> {
  return cases.flatMap((evalCase) => {
    if (label !== null && !evalCase.labels.includes(label)) return [];
    const caseVersion = currentRow(evalCase);
    return caseVersion ? [{ evalCase, caseVersion }] : [];
  });
}

function frozenCase(evalCase: EvalCase, version: CaseVersion, evalId: string): FrozenCase {
  return {
    caseId: evalCase.id,
    versionId: version.id,
    number: version.number,
    name: evalCase.name,
    evalId,
  };
}

function snapshotsOf(version: Pick<EvalVersion, "scorers">): ScorerSnapshot[] {
  return version.scorers.map(snapshotOf);
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

/** The trials of a case: the trials of its eval, else the trials of the run. */
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
 * The params of a trial: the params of its eval with the run's over them, else the run's, with the
 * params of its variant over all.
 */
export function paramsOfTrial(
  experiment: Pick<Experiment, "caseVersions" | "evalVersions" | "params" | "variants">,
  trial: Pick<Trial, "caseVersionId" | "variant">,
): Record<string, unknown> {
  const base = evalOfVersion(experiment, trial.caseVersionId)?.params ?? experiment.params;
  const variant = experiment.variants.find(({ index }) => index === trial.variant);
  return variant ? { ...base, ...variant.params } : base;
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
