import {
  type FeatureFlagDeps,
  featureEnabled,
  featureOffForAll,
  organizationIdsWithFeature,
} from "@/lib/platform/experimental-features";

/**
 * Whether Sandboxes are on for a project: the `evals` switch, off by default (ADR-0004). One
 * switch gates the sandbox and the evals together. Owner: rstagi. Remove this file and the flag
 * once it is on for every organization.
 */
export function sandboxesEnabledForProject(
  projectId: string,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return featureEnabled("evals", { projectId }, deps);
}

/** Whether the switch is off for every project, known with no project: a route can answer 404 first. */
export function sandboxesOffForAll(deps: Partial<FeatureFlagDeps> = {}): boolean {
  return featureOffForAll("evals", deps);
}

/** The organizations whose rail shows Sandboxes. A failed decision hides it. */
export function sandboxOrganizationIds(
  organizations: ReadonlyArray<{ id: string }>,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<string[]> {
  return organizationIdsWithFeature("evals", organizations, deps);
}
