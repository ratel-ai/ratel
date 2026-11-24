import { DashboardsListView } from "@/components/console/dashboards/DashboardsListView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { listDashboards } from "@/lib/views/dashboards/store";
import { dashboardsScope } from "./context";

export const metadata = { title: "Dashboards" };

/** The project's dashboards, behind `customDashboards`. */
export default async function ScopedDashboardsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const scope = await dashboardsScope(projectId);
  if (!scope)
    return (
      <DatabaseUnavailable title="Dashboards">
        Dashboards become available once setup finishes.
      </DatabaseUnavailable>
    );
  const dashboards = await listDashboards(scope.project.id);
  return (
    <DashboardsListView
      projectId={scope.project.id}
      now={new Date().toISOString()}
      dashboards={dashboards.map(({ id, name, widgets, updatedAt }) => ({
        id,
        name,
        widgets: widgets.length,
        updatedAt: updatedAt.toISOString(),
      }))}
    />
  );
}
