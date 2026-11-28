import type { EvalContent, EvalDefinition, EvalDetails } from "../domain/eval";

export type NewEval = EvalDetails & { projectId: string; content: EvalContent; createdBy: string };

/**
 * An edit. A field that it does not give keeps the value of the newest version: the dataset, the
 * pinned runtime version and the matrix.
 */
export type EvalEdit = EvalDetails & {
  content: Omit<EvalContent, "sandboxVersionId" | "matrix"> &
    Partial<Pick<EvalContent, "sandboxVersionId" | "matrix">>;
};

export type EvalWriteRefusal = "not_found" | "changed" | "name_taken" | "dataset_not_found";

/** The evals of a project. No method changes a version: an edit adds one. */
export interface EvalStore {
  /**
   * Adds an eval with its first version. With no dataset, the eval gets its own fixed dataset.
   * `dataset_not_found`: the project has no such dataset.
   */
  create(input: NewEval): Promise<EvalDefinition | "name_taken" | "dataset_not_found">;
  get(projectId: string, evalId: string): Promise<EvalDefinition | null>;
  /** By name, as a person or an agent writes it. */
  getByName(projectId: string, name: string): Promise<EvalDefinition | null>;
  /** The oldest first, so the order of a suite does not change. */
  list(projectId: string): Promise<EvalDefinition[]>;
  /**
   * Writes the name and the task, and adds a version when the content differs from the newest
   * one. `base` is the id of the newest version as the person read it.
   */
  update(
    projectId: string,
    evalId: string,
    edit: EvalEdit,
    base: string,
    by: { userId: string; now: Date },
  ): Promise<EvalDefinition | EvalWriteRefusal>;
}
