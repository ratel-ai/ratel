import type { CaseContent, CaseDetails, EvalCase } from "../domain/case";

export type NewCase = CaseDetails & {
  projectId: string;
  /**
   * The eval whose dataset gets the case (the dataset of its newest version), or the fixed dataset
   * itself. One of the two.
   */
  evalId?: string;
  datasetId?: string;
  content: CaseContent;
  createdBy: string;
  /** The turn or the sandbox run that the case was saved from. A run has no turn id. */
  source?: { turnId: string | null; output: string | null };
};

export type CaseRefusal = "eval_not_found" | "not_fixed";

/** The newest version of a case as the person read it. */
export type VersionToken = { versionId: string };

/**
 * The cases (the rows of the datasets) of a project. A version never changes: an edit adds a
 * version, and the newest counts (decision `rows-count-at-once`).
 */
export interface CaseStore {
  /**
   * Adds a case with its first version. `eval_not_found`: the project has no such eval or dataset.
   * `not_fixed`: the dataset is a query, so it has no rows of its own.
   */
  create(input: NewCase): Promise<EvalCase | CaseRefusal>;
  /** Adds the cases in one transaction, in order. A refusal for one of them: none is added. */
  createAll(inputs: readonly NewCase[]): Promise<EvalCase[] | CaseRefusal>;
  get(projectId: string, caseId: string): Promise<EvalCase | null>;
  /** The newest first. With an eval, only the rows of its dataset (of its newest version). */
  list(projectId: string, evalId?: string): Promise<EvalCase[]>;
  /** The rows of one dataset, the newest first. */
  listDataset(projectId: string, datasetId: string): Promise<EvalCase[]>;
  /** Writes the name and the labels, and adds a version when the content differs from the newest. */
  update(
    projectId: string,
    caseId: string,
    edit: CaseDetails & { content: CaseContent },
    base: VersionToken,
    now: Date,
  ): Promise<EvalCase | "not_found" | "changed">;
}
