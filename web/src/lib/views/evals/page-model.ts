import type { Member } from "@/lib/console/scope/member-access";
import { approvedVersion, type CaseVersion, draftVersion, type EvalCase } from "./domain/case";

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
