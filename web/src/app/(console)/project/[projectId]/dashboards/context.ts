import { findProjectScope, type ProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";

/** The reader's project, or null where no database is connected. The project layout already guarded the id. */
export async function dashboardsScope(projectId: string): Promise<ProjectScope | null> {
  return isDbConfigured() ? findProjectScope(projectId) : null;
}

/** Whether the project's organization has `customDashboards`. */
export async function dashboardsEnabled(projectId: string): Promise<boolean> {
  const scope = await dashboardsScope(projectId);
  return featureEnabled("customDashboards", scope ? { organizationId: scope.organization.id } : {});
}
