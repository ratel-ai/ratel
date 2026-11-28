import { DashboardsListView } from "@/components/console/dashboards/DashboardsListView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { askConfigured } from "@/lib/views/ask/model";
import { listDashboards } from "@/lib/views/dashboards/store";
import { dashboardsScope } from "./context";

/** The project's dashboards: what `page.tsx` shows with `customMonitoring` on. */
export async function DashboardsList({ projectId }: { projectId: string }) {
  const scope = await dashboardsScope(projectId);
  if (!scope)
    return (
      <DatabaseUnavailable title="Dashboards">
        Dashboards become available once setup finishes.
      </DatabaseUnavailable>
    );
  const [dashboards, restricted] = await Promise.all([
    listDashboards(scope.project.id),
    isRestrictedBySupportSession(),
  ]);
  return (
    <DashboardsListView
      projectId={scope.project.id}
      now={new Date().toISOString()}
      // A support session may not ask for a draft.
      ask={askConfigured() && !restricted}
      dashboards={dashboards.map(({ id, name, widgetCount, updatedAt, updatedByName }) => ({
        id,
        name,
        widgets: widgetCount,
        updatedAt: updatedAt.toISOString(),
        updatedBy: updatedByName,
      }))}
    />
  );
}
