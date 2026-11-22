import { notFound } from "next/navigation";
import { DashboardSharing } from "@/components/console/custom-dashboards/DashboardSharing";
import { DashboardView } from "@/components/console/custom-dashboards/DashboardView";
import type { EditorFacets } from "@/components/console/custom-dashboards/WidgetEditor";
import { requireProjectScope } from "@/components/console/settings/project-scope";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { listPivots } from "@/lib/ingest/pivots/store";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  defaultTraceFilterFacetWindow,
  getTraceFilterFacets,
} from "@/lib/synthesis/traces/trace-filters";
import { readDashboard } from "@/lib/views/custom-dashboards/service";
import { sessionDashboardsDeps } from "@/lib/views/custom-dashboards/session";
import { parseWidgetSpec } from "@/lib/views/custom-dashboards/spec";
import { loadWidgetData } from "@/lib/views/custom-dashboards/widget-data";

export const metadata = { title: "Dashboard" };

const NO_FACETS: EditorFacets = { model: [], service: [], environment: [] };
const FACETS_PER_FIELD = 10;

/**
 * One dashboard (RC-888). A dashboard the member may not open is not found:
 * a private one opens for its creator only, a project one for every member
 * (RC-889). The link asks for sign-in and project membership first.
 * Every widget's query runs at the same time; one that fails shows its own
 * error and the rest of the page still works.
 */
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ projectId: string; dashboardId: string }>;
}) {
  const { projectId, dashboardId } = await params;
  if (!isDbConfigured()) {
    return (
      <DatabaseUnavailable title="Dashboards">
        Dashboards become available once setup finishes.
      </DatabaseUnavailable>
    );
  }
  const { project } = await requireProjectScope(projectId);
  const read = await readDashboard(project.id, dashboardId, sessionDashboardsDeps());
  if (!read.ok) notFound();

  const pivots = await listPivots(project.id, getDb());
  const [data, facets] = await Promise.all([
    loadWidgetData(project.id, read.widgets, { pivots }),
    loadFacets(project.id),
  ]);
  const widgets = read.widgets.map((widget, index) => {
    const parsed = parseWidgetSpec(widget.spec);
    return { id: widget.id, spec: parsed.ok ? parsed.spec : null, data: data[index] };
  });

  return (
    <DashboardView
      projectId={project.id}
      dashboard={{
        id: read.dashboard.id,
        name: read.dashboard.name,
        sharing: read.dashboard.sharing,
      }}
      canEdit={read.canEdit}
      widgets={widgets}
      pivots={pivots.map((pivot) => ({ key: pivot.key, label: pivot.label }))}
      facets={facets}
      sharingControls={
        <DashboardSharing
          projectId={project.id}
          dashboardId={read.dashboard.id}
          sharing={read.dashboard.sharing}
          canShare={read.canShare}
        />
      }
    />
  );
}

/** The filter values the editor offers; a slow or failed read offers none rather than failing the page. */
function loadFacets(projectId: string): Promise<EditorFacets> {
  return loadOrFallback<EditorFacets>({
    operation: "dashboard_filter_facets",
    distinctId: `project:${projectId}`,
    fallback: NO_FACETS,
    load: async () => {
      const facets = await getTraceFilterFacets(
        projectId,
        defaultTraceFilterFacetWindow(new Date()),
        getDb(),
        FACETS_PER_FIELD,
      );
      return {
        model: facets.model.map((facet) => facet.value),
        service: facets.service.map((facet) => facet.value),
        environment: facets.environment.map((facet) => facet.value),
      };
    },
  });
}
