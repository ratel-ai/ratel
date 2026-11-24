import type { CoreFlag } from "@/lib/contracts/feature-flags";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { FEATURE_PAGES, type FeaturePage } from "./navigation";

/**
 * The rail's check for Scorers, Dashboards and Alerts: the pages whose flag is on, per
 * organization id. A failed decision hides that page only.
 */
export async function featurePagesByOrganization(
  organizations: readonly { id: string }[],
  enabled: (flag: CoreFlag, organization: { id: string }) => Promise<boolean> = (
    flag,
    { id: organizationId },
  ) => featureEnabled(flag, { organizationId }),
): Promise<Record<string, FeaturePage[]>> {
  return Object.fromEntries(
    await Promise.all(
      organizations.map(async (organization) => {
        const decided = await Promise.all(
          FEATURE_PAGES.map((flag) => enabled(flag, organization).catch(() => false)),
        );
        return [organization.id, FEATURE_PAGES.filter((_, index) => decided[index])] as const;
      }),
    ),
  );
}
