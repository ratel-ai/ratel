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

/** The newest version of a case as the person read it. */
export type VersionToken = { versionId: string };

/**
 * The cases (the rows of the datasets) of a project. A version never changes: an edit adds a
 * version, and the newest counts (decision `rows-count-at-once`).
 */
export interface CaseStore {
  /** Adds a case with its first version. `eval_not_found`: the project has no such eval. */
  create(input: NewCase): Promise<EvalCase | "eval_not_found">;
  /** Adds the cases in one transaction, in order. `eval_not_found` for one of them: none is added. */
  createAll(inputs: readonly NewCase[]): Promise<EvalCase[] | "eval_not_found">;
  get(projectId: string, caseId: string): Promise<EvalCase | null>;
  /** The newest first. With an eval, only its dataset. */
  list(projectId: string, evalId?: string): Promise<EvalCase[]>;
  /** Writes the name and the labels, and adds a version when the content differs from the newest. */
  update(
    projectId: string,
    caseId: string,
    edit: CaseDetails & { content: CaseContent },
    base: VersionToken,
    now: Date,
  ): Promise<EvalCase | "not_found" | "changed">;
}
