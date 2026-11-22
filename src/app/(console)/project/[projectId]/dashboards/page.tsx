import { notFound, redirect } from "next/navigation";
import { DashboardList } from "@/components/console/custom-dashboards/DashboardList";
import { requireProjectScope } from "@/components/console/settings/project-scope";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { projectRoot } from "@/lib/console/navigation";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { readDashboards } from "@/lib/views/custom-dashboards/service";
import {
  customDashboardsEnabled,
  sessionDashboardsDeps,
} from "@/lib/views/custom-dashboards/session";

export const metadata = { title: "Dashboards" };

/**
 * Dashboards (RC-888). With `cloud-custom-dashboards` on: the project's
 * dashboards this member opens. Off, Overview carries the numbers, and its
 * Spend opens the context split this page used to show. The redirect is
 * temporary (307), so a browser does not keep it once the flag turns on.
 */
export default async function ScopedDashboardsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!(await customDashboardsEnabled())) redirect(`${projectRoot(projectId)}?peek=context`);
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Dashboards">
        Dashboards become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const { project } = await requireProjectScope(projectId);
  const [result, session] = await Promise.all([
    readDashboards(project.id, sessionDashboardsDeps({ flagChecked: true })),
    getSessionContext(),
  ]);
  if (!result.ok) notFound();
  const externalId = session?.user.externalId;
  return (
    <DashboardList
      projectId={project.id}
      dashboards={result.dashboards.map((dashboard) => ({
        id: dashboard.id,
        name: dashboard.name,
        sharing: dashboard.sharing,
        mine: dashboard.createdBy === externalId,
        updatedAt: dashboard.updatedAt.toISOString(),
      }))}
    />
  );
}
