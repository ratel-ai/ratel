import type { EvalContent, EvalDefinition, EvalDetails, EvalVersion } from "../domain/eval";

export type NewEval = EvalDetails & { projectId: string; content: EvalContent; createdBy: string };

export type EvalEdit = EvalDetails & { content: EvalContent };

export type EvalWriteRefusal = "not_found" | "changed" | "name_taken";

/** The evals of a project. No method changes a version: an edit adds one. */
export interface EvalStore {
  /** Adds an eval with its first version. */
  create(input: NewEval): Promise<EvalDefinition | "name_taken">;
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
  /** The versions with these ids, for the runs that froze them. */
  versions(versionIds: readonly string[]): Promise<EvalVersion[]>;
}
