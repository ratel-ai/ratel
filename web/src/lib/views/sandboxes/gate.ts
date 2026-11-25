import { getConfig } from "@/config";
import { composition } from "@/lib/composition/ports";
import {
  experimentalFeatureEnabled,
  type FeatureFlagDeps,
  featureEnabled,
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
  const config = deps.config ?? getConfig();
  if (config.flags.sandboxes === false) return true;
  const port = "port" in deps ? deps.port : composition.featureFlags;
  return !port && !experimentalFeatureEnabled("sandboxes", config, deps.edition);
}
