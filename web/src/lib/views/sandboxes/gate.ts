import { type FeatureFlagDeps, featureEnabled } from "@/lib/platform/experimental-features";

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
