import { featureEnabled } from "@/lib/platform/experimental-features";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";

export interface OfferedDeps {
  organization: (projectId: string) => Promise<{ id: string } | null>;
  customMonitoring: (subject: { projectId: string; organizationId: string }) => Promise<boolean>;
}

const PROJECT: OfferedDeps = {
  organization: getOrganizationByProjectId,
  customMonitoring: (subject) => featureEnabled("customMonitoring", subject),
};

/** Whether a project has dashboards: the flag is its organization's. */
export async function projectDashboardsOn(
  projectId: string,
  deps: OfferedDeps = PROJECT,
): Promise<boolean> {
  const organization = await deps.organization(projectId);
  return (
    organization !== null && deps.customMonitoring({ projectId, organizationId: organization.id })
  );
}
