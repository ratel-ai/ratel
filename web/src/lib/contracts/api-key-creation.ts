/**
 * Whether an organization may be given new API keys now. Absent in the open-source edition, which
 * never refuses one. Existing keys are not affected.
 */
export type ApiKeyCreationPort = {
  /** When new keys become available; null: now. Called before a key, or the first project, is made. */
  blockedUntil(organizationId: string): Promise<Date | null>;
};
