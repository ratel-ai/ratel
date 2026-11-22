import type { Organization } from "@/lib/contracts/session";
import { type FeatureFlagDeps, featureEnabled } from "@/lib/platform/experimental-features";

/**
 * Whether the ship watch (`FF_SHIP_MONITOR`, upstream's `cloud-ship-monitor`) is on: for the
 * signed-in person in the project's organization (the Ship page and its route), or for an MCP
 * caller with no session (an API key or an OAuth user), decided with the project.
 *
 * Owned (ADR-0030): a core switch, off by default. Without the edition's flags port it is one
 * switch for the deployment, read from the environment (or `RATEL_EXPERIMENTAL_FEATURES` in the
 * open-source edition); with it, the edition decides it (`featureEnabled`). Upstream's names
 * stay, so every caller stays upstream's.
 */

export const SHIP_MONITOR_FLAG = "FF_SHIP_MONITOR" as const;

export function shipMonitorEnabledFor(
  organization: Pick<Organization, "id">,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return featureEnabled(SHIP_MONITOR_FLAG, { organizationId: organization.id }, deps);
}

export function shipMonitorEnabledForActor(
  projectId: string,
  actor: string,
  deps: Partial<FeatureFlagDeps> = {},
): Promise<boolean> {
  return featureEnabled(SHIP_MONITOR_FLAG, { projectId, actor }, deps);
}
