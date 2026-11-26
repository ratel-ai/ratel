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
  createdAt: string;
  counts: Counts;
  cases: Array<CaseCounts & { trials: TrialView[] }>;
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

export function experimentPageModel(
  experiment: Experiment,
  trials: readonly Trial[],
): ExperimentPageModel {
  const byCase = trialsByCase(trials);
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
    createdAt: experiment.createdAt.toISOString(),
    counts: countTrials(trials),
    cases: caseCounts(experiment, trials).map((row) => ({
      ...row,
      trials: trialViews(byCase.get(row.versionId)),
    })),
  };
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
  sandboxName: string;
  commit: string;
  dirty: boolean;
};
export type ComparedCaseSide = CaseSide & {
  /** Of the trials that have one. Null when none has. */
  costUsd: number | null;
  meanDurationMs: number | null;
  trials: TrialView[];
};
export type ComparedCaseRow = {
  caseId: string;
  name: string;
  change: CaseChange;
  baseline: ComparedCaseSide | null;
  candidate: ComparedCaseSide | null;
};
export type ComparePageModel = { projectId: string; experimentId: string } & (
  | {
      ok: true;
      verdict: Verdict;
      rule: string;
      baseline: ComparedExperiment;
      candidate: ComparedExperiment;
      pinnedBy: string;
      pinnedAt: string;
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
): ComparePageModel {
  if (!result.ok) {
    const { pin, ...refusal } = result.refusal;
    return { ...ids, ok: false, ...refusal, baselineId: pin?.experimentId ?? null };
  }
  const { pin, baseline, candidate, comparison } = result;
  const before = trialsByCase(baseline.trials);
  const after = trialsByCase(candidate.trials);
  const row = (compared: ComparedCase): ComparedCaseRow => ({
    ...compared,
    baseline: comparedSide(compared.baseline, before),
    candidate: comparedSide(compared.candidate, after),
  });
  return {
    ...ids,
    ok: true,
    verdict: comparison.verdict,
    rule: comparison.rule,
    baseline: comparedExperiment(baseline.experiment),
    candidate: comparedExperiment(candidate.experiment),
    pinnedBy: personOf(pin.pinnedBy, reader),
    pinnedAt: pin.pinnedAt.toISOString(),
    changed: changedCases(comparison).map(row),
    others: otherCases(comparison).map(row),
  };
}

function comparedSide(
  side: CaseSide | null,
  byCase: ReadonlyMap<string, Trial[]>,
): ComparedCaseSide | null {
  if (!side) return null;
  const trials = byCase.get(side.versionId) ?? [];
  const costs = trials.flatMap(({ costUsd }) => (costUsd === null ? [] : [costUsd]));
  const durations = trials.flatMap(({ durationMs }) => (durationMs === null ? [] : [durationMs]));
  return {
    ...side,
    costUsd: costs.length > 0 ? sum(costs) : null,
    meanDurationMs: durations.length > 0 ? sum(durations) / durations.length : null,
    trials: trialViews(trials),
  };
}

function comparedExperiment(experiment: Experiment): ComparedExperiment {
  const { id, sandboxName, gitCommit, gitDirty } = experiment;
  return { id, sandboxName, commit: gitCommit, dirty: gitDirty };
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
