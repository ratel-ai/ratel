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

export type CreateRefusal = "eval_not_found" | "dataset_not_fixed";

/** The newest version of a case as the person read it. */
export type VersionToken = { versionId: string };

/**
 * The cases (the rows of the datasets) of a project. A version never changes: an edit adds a
 * version, and the newest counts (decision `rows-count-at-once`).
 */
export interface CaseStore {
  /**
   * Adds a case with its first version to the dataset of the eval. `eval_not_found`: the project
   * has no such eval. `dataset_not_fixed`: the dataset of the eval is a query, which holds no row.
   */
  create(input: NewCase): Promise<EvalCase | CreateRefusal>;
  /** Adds the cases in one transaction, in order. A refusal for one of them: none is added. */
  createAll(inputs: readonly NewCase[]): Promise<EvalCase[] | CreateRefusal>;
  get(projectId: string, caseId: string): Promise<EvalCase | null>;
  /** The newest first, with no row that a query resolved. With an eval, only the rows of its dataset. */
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
