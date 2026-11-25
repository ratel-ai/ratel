import type { CaseContent, CaseDetails, EvalCase } from "../domain/case";

export type NewCase = CaseDetails & {
  projectId: string;
  content: CaseContent;
  createdBy: string;
  source?: { turnId: string; output: string | null };
};

export type ApproveResult = "approved" | "not_found" | "changed";

/** The cases of a project. No method changes an approved version. */
export interface CaseStore {
  /** Adds a case with one draft. */
  create(input: NewCase): Promise<EvalCase>;
  get(projectId: string, caseId: string): Promise<EvalCase | null>;
  /** The newest first. */
  list(projectId: string): Promise<EvalCase[]>;
  /** Writes the draft, or a new draft when there is none and the content differs. */
  saveDraft(
    projectId: string,
    caseId: string,
    edit: CaseDetails & { content: CaseContent },
    now: Date,
  ): Promise<EvalCase | null>;
  /** Approves the draft as the person saw it (`updatedAt`). */
  approve(
    projectId: string,
    caseId: string,
    draft: { versionId: string; updatedAt: Date },
    by: { userId: string; now: Date },
  ): Promise<ApproveResult>;
}
