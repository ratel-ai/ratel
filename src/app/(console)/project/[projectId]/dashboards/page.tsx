import { notFound } from "next/navigation";
import { DashboardList } from "@/components/console/custom-dashboards/DashboardList";
import { requireProjectScope } from "@/components/console/settings/project-scope";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getSessionContext } from "@/lib/platform/session";
import { readDashboards } from "@/lib/views/custom-dashboards/service";
import { sessionDashboardsDeps } from "@/lib/views/custom-dashboards/session";

export const metadata = { title: "Dashboards" };

/**
 * Dashboards (RC-888): the project's dashboards this member opens.
 */
export default async function ScopedDashboardsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Dashboards">
        Dashboards become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const { project } = await requireProjectScope(projectId);
  const [result, session] = await Promise.all([
    readDashboards(project.id, sessionDashboardsDeps()),
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
