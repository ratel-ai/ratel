import { getConfig } from "@/config";
import {
  type FlagConfig,
  featureEnabled,
  organizationIdsWith,
} from "@/lib/platform/experimental-features";
import type { Organization } from "@/lib/platform/organizations";

/**
 * The simplified console (`focusedConsole`), off by default. The rail and the pages both decide it
 * for the project's organization, so a page never disagrees with the rail around it. A configured
 * `false` is off even with `experimentalFeatures` on: the operator asked to keep today's console.
 * Every reader of the flag goes through here, never through `featureEnabled`.
 */
export async function focusedConsoleEnabled(
  organization: Pick<Organization, "id">,
  config: FlagConfig = getConfig(),
): Promise<boolean> {
  if (config.flags.focusedConsole === false) return false;
  return featureEnabled("focusedConsole", { organizationId: organization.id }, { config });
}

/** The organizations whose rail is the simplified one. A failed decision keeps today's rail. */
export function focusedConsoleOrganizationIds(
  organizations: readonly Pick<Organization, "id">[],
  enabled: (organization: Pick<Organization, "id">) => Promise<boolean> = focusedConsoleEnabled,
): Promise<string[]> {
  return organizationIdsWith(organizations, enabled);
}
