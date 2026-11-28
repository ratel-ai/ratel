import type { Member } from "@/lib/console/scope/member-access";
import type { SandboxVersionSummary } from "@/lib/views/sandboxes";
import type { ParamSpec } from "@/lib/views/sandboxes/run-form";
import { type CaseVersion, currentVersion as currentRow, type EvalCase } from "./domain/case";
import { currentVersion, type EvalDefinition, type EvalScorer } from "./domain/eval";
import {
  type Counts,
  countTrials,
  type Experiment,
  type ExperimentState,
  type Trial,
} from "./domain/experiment";
import { type CaseCounts, caseCounts, trialsByCase } from "./experiment-view";

/** What the pages of evals show. Plain data. */

/** The longest text of a cell of the cases table. The case page shows the full value. */
export const PREVIEW_CHARS = 160;

export type CaseVersionView = Omit<CaseVersion, "updatedAt"> & { updatedAt: string };

export type CaseEditorModel = {
  projectId: string;
  canEdit: boolean;
  /** Null for a new case. */
  id: string | null;
  name: string;
  labels: string[];
  /** The eval whose dataset has the case. Null for a new case: the person chooses it. */
  evalId: string | null;
  /** The evals of the project, with the scorers of their newest version. */
  evals: EvalOption[];
  /** The version that counts: the newest. Null for a new case. */
  current: CaseVersionView | null;
};

export type EvalOption = { id: string; name: string; scorers: EvalScorer[] };

export type CaseEditor = Pick<Member, "projectId"> & { canEdit: boolean };

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
  evals: readonly EvalDefinition[],
  /** The eval that a new case goes to first, when the page names one. */
  chosenEvalId: string | null = null,
): CaseEditorModel {
  return {
    projectId,
    canEdit,
    id: evalCase?.id ?? null,
    name: evalCase?.name ?? "",
    labels: evalCase?.labels ?? [],
    evalId: evalCase?.evalId ?? (evals.some(({ id }) => id === chosenEvalId) ? chosenEvalId : null),
    evals: evals.map((definition) => ({
      id: definition.id,
      name: definition.name,
      scorers: currentVersion(definition).scorers,
    })),
    current: versionView(evalCase && currentRow(evalCase)),
  };
}

function versionView(version: CaseVersion | null): CaseVersionView | null {
  return version && { ...version, updatedAt: version.updatedAt.toISOString() };
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
  /** The label that chose the cases. Null: all cases. */
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

function trialViews(trials: readonly Trial[] = []): TrialView[] {
  return trials.map(({ experimentId: _, ...trial }) => trial);
}
