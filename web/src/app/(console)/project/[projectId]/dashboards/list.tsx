import { DashboardsListView } from "@/components/console/dashboards/DashboardsListView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { getDb } from "@/lib/platform/db/client";
import { isRestrictedBySupportSession } from "@/lib/platform/support-session";
import { askConfigured } from "@/lib/views/ask/model";
import { listDashboards } from "@/lib/views/dashboards/store";
import { loadTemplateFacts, templateCards } from "@/lib/views/dashboards/templates/data";
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
  const [dashboards, facts] = await Promise.all([
    listDashboards(scope.project.id),
    loadTemplateFacts(scope.project.id, getDb()),
  ]);
  return (
    <DashboardsListView
      projectId={scope.project.id}
      now={new Date().toISOString()}
      // A support session may not ask for a draft.
      ask={askConfigured() && !restricted}
      templates={restricted ? [] : templateCards(facts)}
      properties={facts.properties}
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
