import type { CaseContent, CaseDetails, EvalCase } from "../domain/case";

export type NewCase = CaseDetails & {
  projectId: string;
  /** The eval whose dataset gets the case. */
  evalId: string;
  content: CaseContent;
  createdBy: string;
  /** The turn or the sandbox run that the case was saved from. A run has no turn id. */
  source?: { turnId: string | null; output: string | null };
};

export type VersionToken = { versionId: string; updatedAt: Date };

export type ApproveResult = "approved" | "not_found" | "changed";

/** The cases of a project. No method changes an approved version. */
export interface CaseStore {
  /** Adds a case with one draft. `eval_not_found`: the project has no such eval. */
  create(input: NewCase): Promise<EvalCase | "eval_not_found">;
  get(projectId: string, caseId: string): Promise<EvalCase | null>;
  /** The newest first. With an eval, only its dataset. */
  list(projectId: string, evalId?: string): Promise<EvalCase[]>;
  /** Writes the draft, or a new draft when there is none and the content differs. */
  saveDraft(
    projectId: string,
    caseId: string,
    edit: CaseDetails & { content: CaseContent },
    /** The newest version as the person read it. */
    base: VersionToken,
    now: Date,
  ): Promise<EvalCase | "not_found" | "changed">;
  /** Approves the draft as the person saw it (`updatedAt`). */
  approve(
    projectId: string,
    caseId: string,
    draft: VersionToken,
    by: { userId: string; now: Date },
  ): Promise<ApproveResult>;
}
