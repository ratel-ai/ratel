/**
 * Upstream's Agent health flag (`lib/trace-signals/flag.ts`, excluded here): Agent health is on for
 * every project in this edition, so the gate always answers yes. Kept so copied callers (the MCP
 * health, runs and loop operations) keep their call and their dependency shape.
 */
export function agentHealthEnabled(_projectId: string, _organization?: unknown): Promise<boolean> {
  return Promise.resolve(true);
}

/** Upstream reshapes the organization for its flag service; here there is nothing to reshape. */
export function toIngestFlagOrganization<T>(organization: T): T {
  return organization;
}
