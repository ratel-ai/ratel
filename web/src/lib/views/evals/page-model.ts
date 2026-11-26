import type { Member } from "@/lib/console/scope/member-access";
import type { SandboxVersionSummary } from "@/lib/views/sandboxes";
import type { ParamSpec } from "@/lib/views/sandboxes/run-form";
import type { ComparisonResult } from "./baseline";
import { approvedVersion, type CaseVersion, draftVersion, type EvalCase } from "./domain/case";
import {
  type CaseChange,
  type CaseSide,
  type ComparedCase,
  changedCases,
  otherCases,
  type ScorerDifference,
  type Verdict,
} from "./domain/compare";
import {
  type Counts,
  countTrials,
  type Experiment,
  type ExperimentState,
  type Trial,
} from "./domain/experiment";
import { type CaseCounts, caseCounts, trialsByCase } from "./experiment-view";

/** What the pages of evals show. Plain data. */
export type CaseRow = {
  id: string;
  name: string;
  labels: string[];
  /** The number of the version that counts. */
  approved: number | null;
  draft: number | null;
  /** The input of the approved version, else of the draft, cut to `PREVIEW_CHARS`. */
  input: string;
  /** The number of earlier turns that go with the input. */
  turns: number;
  /** The expected output, cut to `PREVIEW_CHARS`. Null when the case has none. */
  expectedOutput: string | null;
  createdAt: string;
};

/** The longest text of a cell of the cases table. The case page shows the full value. */
export const PREVIEW_CHARS = 160;

export type CaseVersionView = Omit<CaseVersion, "approvedAt" | "updatedAt"> & {
  approvedAt: string | null;
  updatedAt: string;
};

export type CaseEditorModel = {
  projectId: string;
  canEdit: boolean;
  /** Null for a new case. */
  id: string | null;
  name: string;
  labels: string[];
  approved: CaseVersionView | null;
  draft: CaseVersionView | null;
};

export type CaseEditor = Pick<Member, "projectId"> & { canEdit: boolean };

export function caseRow(evalCase: EvalCase): CaseRow {
  const approved = approvedVersion(evalCase);
  const draft = draftVersion(evalCase);
  const shown = approved ?? draft;
  return {
    id: evalCase.id,
    name: evalCase.name,
    labels: evalCase.labels,
    approved: approved?.number ?? null,
    draft: draft?.number ?? null,
    input: shown ? preview(shown.input) : "",
    turns: shown?.earlierTurns.length ?? 0,
    expectedOutput: shown?.expectedOutput ? preview(shown.expectedOutput) : null,
    createdAt: evalCase.createdAt.toISOString(),
  };
}

/** The labels of the cases, each one time, in order. */
export function caseLabels(rows: readonly Pick<CaseRow, "labels">[]): string[] {
  return [...new Set(rows.flatMap(({ labels }) => labels))].sort();
}

/** The cases that a run takes: the approved ones, with the label when there is one. */
export function runnableCases(
  rows: readonly Pick<CaseRow, "labels" | "approved">[],
  label: string | null,
): number {
  return rows.filter(
    (row) => row.approved !== null && (label === null || row.labels.includes(label)),
  ).length;
}

/** A value as one line of text, cut to `PREVIEW_CHARS`. */
export function preview(value: unknown): string {
  const text = (typeof value === "string" ? value : JSON.stringify(value ?? null)).replace(
    /\s+/g,
    " ",
  );
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}

export function caseEditorModel(
  { projectId, canEdit }: CaseEditor,
  evalCase: EvalCase | null,
): CaseEditorModel {
  return {
    projectId,
    canEdit,
    id: evalCase?.id ?? null,
    name: evalCase?.name ?? "",
    labels: evalCase?.labels ?? [],
    approved: versionView(evalCase && approvedVersion(evalCase)),
    draft: versionView(evalCase && draftVersion(evalCase)),
  };
}

function versionView(version: CaseVersion | null): CaseVersionView | null {
  return (
    version && {
      ...version,
      approvedAt: version.approvedAt?.toISOString() ?? null,
      updatedAt: version.updatedAt.toISOString(),
    }
  );
}

export type ExperimentRow = {
  id: string;
  sandboxName: string;
  commit: string;
  state: ExperimentState;
  cases: number;
  counts: Counts;
  createdAt: string;
};

export type ReadyVersion = { id: string; name: string; commit: string; params: ParamSpec[] };

export type TrialView = Omit<Trial, "experimentId">;

export type ExperimentPageModel = {
  projectId: string;
  id: string;
  state: ExperimentState;
  sandboxName: string;
  sandboxVersionId: string;
  commit: string;
  dirty: boolean;
  params: Record<string, unknown>;
  trialsPerCase: number;
  /** The name that the person gave the run. Null when it has none. */
  name: string | null;
  /** The label that chose the cases. Null: all approved cases. */
  labelFilter: string | null;
  createdAt: string;
  counts: Counts;
  /** The sum of the cost of the trials that report one. Null when none does. */
  costUsd: number | null;
  /** One column for each scorer name of the cases, in the order of the cases. */
  scorers: ScorerColumn[];
  rows: GridRow[];
};

export type ScorerColumn = { name: string; gating: boolean };

/** The raw counts of one scorer over the trials of a case. */
export type ScorerCount = { pass: number; fail: number; notScored: number };

/** A trial with its output, cut to `PREVIEW_CHARS`. Null when it has none. */
export type GridTrial = TrialView & { output: string | null };

/** One case of the experiment grid: what it asked, what the agent answered, how it scored. */
export type GridRow = CaseCounts & {
  /** The input, cut to `PREVIEW_CHARS`. Empty when the case version is gone. */
  input: string;
  /** The number of earlier turns in the input. */
  turns: number;
  expectedOutput: string | null;
  /** By the name of the scorer column. A scorer that the case does not have is not there. */
  scorerCounts: Record<string, ScorerCount>;
  /** The mean of the trials that report one. */
  durationMs: number | null;
  costUsd: number | null;
  trials: GridTrial[];
};

export function experimentRow(experiment: Experiment, counts: Counts): ExperimentRow {
  return {
    id: experiment.id,
    sandboxName: experiment.sandboxName,
    commit: experiment.gitCommit,
    state: experiment.state,
    cases: experiment.caseVersions.length,
    counts,
    createdAt: experiment.createdAt.toISOString(),
  };
}

/**
 * The experiment as a grid: one row for each case. `versions` are the frozen case versions and
 * `outputs` the cut outputs by trial id. A row with no version or no output stays, with empty text.
 */
export function experimentPageModel(
  experiment: Experiment,
  trials: readonly Trial[],
  {
    versions = [],
    outputs = new Map(),
  }: { versions?: readonly CaseVersion[]; outputs?: ReadonlyMap<string, string> } = {},
): ExperimentPageModel {
  const byCase = trialsByCase(trials);
  const byVersion = new Map(versions.map((version) => [version.id, version]));
  const scorers = scorerColumns(experiment);
  return {
    projectId: experiment.projectId,
    id: experiment.id,
    state: experiment.state,
    sandboxName: experiment.sandboxName,
    sandboxVersionId: experiment.sandboxVersionId,
    commit: experiment.gitCommit,
    dirty: experiment.gitDirty,
    params: experiment.params,
    trialsPerCase: experiment.trialsPerCase,
    name: experiment.name,
    labelFilter: experiment.labelFilter,
    createdAt: experiment.createdAt.toISOString(),
    counts: countTrials(trials),
    costUsd: sumOf(trials.map(({ costUsd }) => costUsd)),
    scorers,
    rows: caseCounts(experiment, trials).map((row) => {
      const caseTrials = byCase.get(row.versionId) ?? [];
      const version = byVersion.get(row.versionId);
      return {
        ...row,
        input: version ? preview(version.input) : "",
        turns: version?.earlierTurns.length ?? 0,
        expectedOutput: version?.expectedOutput ? preview(version.expectedOutput) : null,
        scorerCounts: scorerCounts(caseTrials),
        durationMs: meanOf(caseTrials.map(({ durationMs }) => durationMs)),
        costUsd: sumOf(caseTrials.map(({ costUsd }) => costUsd)),
        trials: trialViews(caseTrials).map((trial) => {
          const output = outputs.get(trial.id);
          return { ...trial, output: output === undefined ? null : preview(output) };
        }),
      };
    }),
  };
}

/** The scorer names of the frozen cases, each one time. Gating when one case has it gating. */
function scorerColumns(experiment: Pick<Experiment, "caseVersions" | "scorerSnapshots">) {
  const columns = new Map<string, ScorerColumn>();
  for (const { versionId } of experiment.caseVersions) {
    for (const { name, gating } of experiment.scorerSnapshots[versionId] ?? []) {
      const known = columns.get(name);
      columns.set(name, { name, gating: gating || (known?.gating ?? false) });
    }
  }
  return [...columns.values()];
}

/** The results of each scorer over the trials, by name. An open trial has no result yet. */
function scorerCounts(trials: readonly Pick<Trial, "scorers">[]): Record<string, ScorerCount> {
  const counts: Record<string, ScorerCount> = {};
  for (const { scorers } of trials) {
    for (const { name, status } of scorers) {
      const count = counts[name] ?? { pass: 0, fail: 0, notScored: 0 };
      counts[name] = count;
      if (status === "pass") count.pass += 1;
      else if (status === "fail") count.fail += 1;
      else count.notScored += 1;
    }
  }
  return counts;
}

function sumOf(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

function meanOf(values: ReadonlyArray<number | null>): number | null {
  const sum = sumOf(values);
  const known = values.filter((value) => value !== null).length;
  return sum === null ? null : sum / known;
}

/** The versions that a run can use, the newest first. */
export function readyVersions(versions: readonly SandboxVersionSummary[]): ReadyVersion[] {
  return versions
    .filter(({ status }) => status === "ready")
    .map(({ id, name, git, params }) => ({ id, name, commit: git?.commit ?? "", params }));
}

/** One of the two experiments of a comparison. */
export type ComparedExperiment = {
  id: string;
  name: string | null;
  sandboxName: string;
  sandboxVersionId: string;
  commit: string;
  dirty: boolean;
  labelFilter: string | null;
  createdAt: string;
};
export type ComparedCaseSide = CaseSide & {
  /** Of the trials that have one. Null when none has. */
  costUsd: number | null;
  meanDurationMs: number | null;
  trials: GridTrial[];
};
/** A param with another value on the two sides. Null: the side does not set it. */
export type ParamChange = { name: string; baseline: string | null; candidate: string | null };
/** An experiment that the reader can compare with. */
export type CompareChoice = { id: string; label: string; pinned: boolean };
/** The longest output text that a comparison diffs. */
export const DIFF_CHARS = 2_000;
export type ComparedCaseRow = {
  caseId: string;
  name: string;
  change: CaseChange;
  baseline: ComparedCaseSide | null;
  candidate: ComparedCaseSide | null;
};
export type ComparePageModel = {
  projectId: string;
  experimentId: string;
  /** The completed experiments that the reader can compare with, the newest first. */
  choices: CompareChoice[];
  /** The experiment that the reader chose. Null: the pinned baseline. */
  chosenId: string | null;
} & (
  | {
      ok: true;
      verdict: Verdict;
      rule: string;
      baseline: ComparedExperiment;
      candidate: ComparedExperiment;
      /** Null: the other side is an experiment that is not pinned. */
      pin: { by: string; at: string } | null;
      params: ParamChange[];
      /** Whether the two sides ran other versions of the sandbox. */
      versionChanged: boolean;
      changed: ComparedCaseRow[];
      others: ComparedCaseRow[];
    }
  | {
      ok: false;
      reason: string;
      message: string;
      scorers: ScorerDifference[];
      /** Null: no baseline is pinned. */
      baselineId: string | null;
    }
);

export function comparePageModel(
  ids: { projectId: string; experimentId: string },
  result: ComparisonResult,
  /** The identity of the reader, to say "you". */
  reader: string,
  {
    outputs = new Map(),
    choices = [],
    chosenId = null,
  }: {
    /** The outputs of the trials of both sides, by trial id. Longer than `DIFF_CHARS` is cut. */
    outputs?: ReadonlyMap<string, string>;
    choices?: CompareChoice[];
    chosenId?: string | null;
  } = {},
): ComparePageModel {
  const shared = { ...ids, choices, chosenId };
  if (!result.ok) {
    const { pin, otherId, ...refusal } = result.refusal;
    return { ...shared, ok: false, ...refusal, baselineId: otherId ?? pin?.experimentId ?? null };
  }
  const { pin, baseline, candidate, comparison } = result;
  const before = trialsByCase(baseline.trials);
  const after = trialsByCase(candidate.trials);
  const row = (compared: ComparedCase): ComparedCaseRow => ({
    ...compared,
    baseline: comparedSide(compared.baseline, before, outputs),
    candidate: comparedSide(compared.candidate, after, outputs),
  });
  return {
    ...shared,
    ok: true,
    verdict: comparison.verdict,
    rule: comparison.rule,
    baseline: comparedExperiment(baseline.experiment),
    candidate: comparedExperiment(candidate.experiment),
    pin: pin && { by: personOf(pin.pinnedBy, reader), at: pin.pinnedAt.toISOString() },
    params: paramChanges(baseline.experiment.params, candidate.experiment.params),
    versionChanged: baseline.experiment.sandboxVersionId !== candidate.experiment.sandboxVersionId,
    changed: changedCases(comparison).map(row),
    others: otherCases(comparison).map(row),
  };
}

/** The params with another value on the two sides, by name. A value shows as its JSON text. */
export function paramChanges(
  baseline: Record<string, unknown>,
  candidate: Record<string, unknown>,
): ParamChange[] {
  const text = (params: Record<string, unknown>, name: string) =>
    Object.hasOwn(params, name) ? JSON.stringify(params[name]) : null;
  return [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])]
    .sort()
    .map((name) => ({ name, baseline: text(baseline, name), candidate: text(candidate, name) }))
    .filter((change) => change.baseline !== change.candidate);
}

/** The label of an experiment in a list: its name, else its sandbox and commit, and its age. */
export function compareChoice(
  experiment: Pick<Experiment, "id" | "name" | "sandboxName" | "gitCommit" | "createdAt">,
  pinnedId: string | null,
): CompareChoice {
  const title =
    experiment.name ?? `${experiment.sandboxName} · ${experiment.gitCommit.slice(0, 12)}`;
  const day = experiment.createdAt.toISOString().slice(0, 16).replace("T", " ");
  const pinned = experiment.id === pinnedId;
  return { id: experiment.id, label: `${title} · ${day}${pinned ? " · baseline" : ""}`, pinned };
}

function comparedSide(
  side: CaseSide | null,
  byCase: ReadonlyMap<string, Trial[]>,
  outputs: ReadonlyMap<string, string>,
): ComparedCaseSide | null {
  if (!side) return null;
  const trials = byCase.get(side.versionId) ?? [];
  const costs = trials.flatMap(({ costUsd }) => (costUsd === null ? [] : [costUsd]));
  const durations = trials.flatMap(({ durationMs }) => (durationMs === null ? [] : [durationMs]));
  return {
    ...side,
    costUsd: costs.length > 0 ? sum(costs) : null,
    meanDurationMs: durations.length > 0 ? sum(durations) / durations.length : null,
    trials: trialViews(trials).map((trial) => ({
      ...trial,
      output: cut(outputs.get(trial.id)),
    })),
  };
}

/** An output of a comparison, with "…" when it is longer than `DIFF_CHARS`. */
function cut(output: string | undefined): string | null {
  if (output === undefined) return null;
  return output.length > DIFF_CHARS ? `${output.slice(0, DIFF_CHARS)}…` : output;
}

function comparedExperiment(experiment: Experiment): ComparedExperiment {
  const { id, name, sandboxName, sandboxVersionId, gitCommit, gitDirty, labelFilter } = experiment;
  return {
    id,
    name,
    sandboxName,
    sandboxVersionId,
    commit: gitCommit,
    dirty: gitDirty,
    labelFilter,
    createdAt: experiment.createdAt.toISOString(),
  };
}

function trialViews(trials: readonly Trial[] = []): TrialView[] {
  return trials.map(({ experimentId: _, ...trial }) => trial);
}

function personOf(pinnedBy: string, reader: string): string {
  if (pinnedBy === reader) return "you";
  return pinnedBy.startsWith("key:") ? "a project key" : "a member";
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
