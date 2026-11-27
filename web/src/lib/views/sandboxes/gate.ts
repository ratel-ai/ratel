import {
  type FeatureFlagDeps,
  featureEnabled,
  featureOffForAll,
  organizationIdsWithFeature,
} from "@/lib/platform/experimental-features";

/**
 * Whether Ratel sandboxes are on for a project: the `sandboxes` switch, off by default (ADR-0004).
 * Owner: rstagi. Remove this file and the flag once it is on for every organization.
 */
export function sandboxesEnabledForProject(
  projectId: string,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return featureEnabled("sandboxes", { projectId }, deps);
}

/** Whether the switch is off for every project, known with no project: a route can answer 404 first. */
export function sandboxesOffForAll(deps: Partial<FeatureFlagDeps> = {}): boolean {
  return featureOffForAll("sandboxes", deps);
}

/** The organizations whose rail shows Ratel sandbox. A failed decision hides it. */
export function sandboxOrganizationIds(
  organizations: ReadonlyArray<{ id: string }>,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<string[]> {
  return organizationIdsWithFeature("sandboxes", organizations, deps);
}
