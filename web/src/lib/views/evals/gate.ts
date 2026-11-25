import {
  type FeatureFlagDeps,
  featureEnabled,
  featureOffForAll,
  organizationIdsWithFeature,
} from "@/lib/platform/experimental-features";

/**
 * Whether evals are on for a project: the `evals` switch, off by default (ADR-0004).
 * Owner: rstagi. Remove this file and the flag once it is on for every organization.
 */
export function evalsEnabledForProject(
  projectId: string,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return featureEnabled("evals", { projectId }, deps);
}

/** Whether the switch is off for every project, known with no project: a route can answer 404 first. */
export function evalsOffForAll(deps: Partial<FeatureFlagDeps> = {}): boolean {
  return featureOffForAll("evals", deps);
}

/** The organizations whose rail shows Evals. A failed decision hides it. */
export function evalsOrganizationIds(
  organizations: ReadonlyArray<{ id: string }>,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<string[]> {
  return organizationIdsWithFeature("evals", organizations, deps);
}
