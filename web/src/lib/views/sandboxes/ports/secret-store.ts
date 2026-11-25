/** The sealed secrets of a project. No method gives or takes a clear value. */
export interface SecretStore {
  list(projectId: string): Promise<Array<{ name: string; updatedAt: Date }>>;
  set(projectId: string, name: string, sealedValue: string, updatedBy: string): Promise<void>;
  /** False when there was none. */
  remove(projectId: string, name: string): Promise<boolean>;
  /** The sealed values of these names, by name. */
  readSealed(projectId: string, names: readonly string[]): Promise<Map<string, string>>;
}
