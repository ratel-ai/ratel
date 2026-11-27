import type { Member } from "@/lib/console/scope/member-access";
import type { SandboxVersionSummary } from "@/lib/views/sandboxes";
import { approvedVersion, type CaseVersion, draftVersion, type EvalCase } from "./domain/case";
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
  createdAt: string;
};

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
  return {
    id: evalCase.id,
    name: evalCase.name,
    labels: evalCase.labels,
    approved: approvedVersion(evalCase)?.number ?? null,
    draft: draftVersion(evalCase)?.number ?? null,
    createdAt: evalCase.createdAt.toISOString(),
  };
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

export type ReadyVersion = { id: string; name: string; commit: string };

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
      trials: (byCase.get(row.versionId) ?? []).map(({ experimentId: _, ...trial }) => trial),
    })),
  };
}

/** The versions that a run can use, the newest first. */
export function readyVersions(versions: readonly SandboxVersionSummary[]): ReadyVersion[] {
  return versions
    .filter(({ status }) => status === "ready")
    .map(({ id, name, git }) => ({ id, name, commit: git.commit }));
}
