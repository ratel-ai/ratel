import { permanentRedirect } from "next/navigation";
import { projectRoot } from "@/lib/console/navigation";
import { findProjectScope, type ProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { featureEnabled } from "@/lib/platform/experimental-features";

/**
 * What the Dashboards pages start from. With `customDashboards` off they are gone, as before:
 * Overview carries the numbers, and its Spend opens the context split Dashboards used to show.
 * Null where no database is connected. The project layout already guarded the id.
 */
export async function dashboardsScope(projectId: string): Promise<ProjectScope | null> {
  const scope = isDbConfigured() ? await findProjectScope(projectId) : null;
  const enabled = await featureEnabled(
    "customDashboards",
    scope ? { organizationId: scope.organization.id } : {},
  );
  if (!enabled) permanentRedirect(`${projectRoot(projectId)}?peek=context`);
  return scope;
}
