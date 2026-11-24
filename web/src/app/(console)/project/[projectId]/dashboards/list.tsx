import { DashboardsListView } from "@/components/console/dashboards/DashboardsListView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { listDashboards } from "@/lib/views/dashboards/store";
import { dashboardsScope } from "./context";

/** The project's dashboards: what `page.tsx` shows with `customDashboards` on. */
export async function DashboardsList({ projectId }: { projectId: string }) {
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
