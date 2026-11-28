import { DashboardsListView } from "@/components/console/dashboards/DashboardsListView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { askConfigured } from "@/lib/views/ask/model";
import { listDashboards } from "@/lib/views/dashboards/store";
import { ensureDefaultDashboards } from "@/lib/views/dashboards/templates/store";
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
  const restricted = await isRestrictedBySupportSession();
  // A project gets Tools, Cost and Reliability one time, where its list is read. A support session
  // may look but not change, so it makes none.
  if (!restricted) await ensureDefaultDashboards(scope.project.id);
  const dashboards = await listDashboards(scope.project.id);
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
