import { featureEnabled } from "@/lib/platform/experimental-features";

/**
 * The rail's check for Scorers, Dashboards and Alerts: the organizations with `customMonitoring`
 * on. A failed decision hides them.
 */
export async function customMonitoringOrganizationIds(
  organizations: readonly { id: string }[],
  enabled: (organization: { id: string }) => Promise<boolean> = ({ id: organizationId }) =>
    featureEnabled("customMonitoring", { organizationId }),
): Promise<string[]> {
  const decided = await Promise.all(
    organizations.map(async (organization) =>
      (await enabled(organization).catch(() => false)) ? [organization.id] : [],
    ),
  );
  return decided.flat();
}
