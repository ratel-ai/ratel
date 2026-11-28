/**
 * The sealed secrets of a project, at two levels: the project (`sandboxName` null) and one
 * sandbox. No method gives or takes a clear value. Each method that has `sandboxName` works on
 * that level only, and a null or absent `sandboxName` is the project level.
 */
export interface SecretStore {
  list(
    projectId: string,
    sandboxName?: string | null,
  ): Promise<Array<{ name: string; updatedAt: Date }>>;
  set(
    projectId: string,
    name: string,
    sealedValue: string,
    updatedBy: string,
    sandboxName?: string | null,
  ): Promise<void>;
  /** False when there was none. */
  remove(projectId: string, name: string, sandboxName?: string | null): Promise<boolean>;
  /**
   * The sealed values of these names at the project level and, when `sandboxName` is given, at the
   * level of that sandbox. One row a level and name.
   */
  readSealed(
    projectId: string,
    names: readonly string[],
    sandboxName?: string | null,
  ): Promise<SealedSecretRow[]>;
}

export type SealedSecretRow = { name: string; sandboxName: string | null; sealedValue: string };
