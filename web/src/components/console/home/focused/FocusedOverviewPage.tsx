import {
  loadOverviewDashboardWidgets,
  loadOverviewHistory,
  restoreOverviewLayoutEntry,
  saveOverviewLayout,
  undoOverviewLayout,
} from "@/app/(console)/project/[projectId]/overview-actions";
import { ContextBreakdown } from "@/components/console/home/ContextBreakdown";
import { ContextPanel } from "@/components/console/home/ContextPanel";
import { FocusedOverviewView } from "@/components/console/home/focused/FocusedOverviewView";
import { SetupGuide } from "@/components/console/home/SetupGuide";
import { TourLauncher } from "@/components/console/onboarding/TourLauncher";
import { loadApiKeyCta } from "@/lib/console/api-key-cta-load";
import { BASE_URL } from "@/lib/platform/app-config";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { loadFocusedOverview } from "@/lib/views/home/focused-load";
import { CONTEXT_PEEK, type OverviewProject } from "@/lib/views/home/load";
import { parseOverviewWindow } from "@/lib/views/home/overview-model";
import { pageLayout } from "@/lib/views/overview-layout/readers";
import { projectEntitiesEnabled } from "@/lib/views/project-entities/flag";

type LoadOrganization = Parameters<typeof loadFocusedOverview>[0]["organization"];

/** Overview with `focusedConsole`: the widgets, as this person arranged them. */
export async function FocusedOverviewPage({
  project,
  organization,
  range,
  peek,
  offerTour,
  inSupportSession,
}: {
  project: OverviewProject;
  organization: LoadOrganization;
  range: string | string[] | undefined;
  peek: string | string[] | undefined;
  offerTour: boolean;
  inSupportSession: boolean;
}) {
  const window = parseOverviewWindow(range);
  const now = new Date();
  const { layout, revision, undo, read } = await pageLayout(project.id);
  const [data, linked, dashboardsOn, apiKey] = await Promise.all([
    loadFocusedOverview({
      project,
      organization,
      window,
      layout,
      now,
      contextOpen: peek === CONTEXT_PEEK,
    }),
    projectEntitiesEnabled(organization),
    featureEnabled("customMonitoring", { projectId: project.id, organizationId: organization.id }),
    // The setup guide shows the key until the first event.
    loadApiKeyCta(project.id, now),
  ]);
  return (
    <FocusedOverviewView
      data={data}
      now={now}
      linked={linked}
      saved={{ revision, undo }}
      layoutActions={
        inSupportSession || !read
          ? null
          : {
              save: saveOverviewLayout.bind(null, project.id),
              undo: undoOverviewLayout.bind(null, project.id),
              restore: restoreOverviewLayoutEntry.bind(null, project.id),
              history: loadOverviewHistory.bind(null, project.id),
              dashboardWidgets: dashboardsOn
                ? loadOverviewDashboardWidgets.bind(null, project.id)
                : null,
            }
      }
      actions={
        // The tour points at the rail, which is a drawer below md.
        <span className="max-md:hidden">
          <TourLauncher
            autoStart={offerTour}
            isDemoProject={project.isDemo}
            surface="project_home"
            record={!inSupportSession}
            focusedConsole
          />
        </span>
      }
      setup={
        <SetupGuide apiKey={apiKey} endpoint={`${BASE_URL}/v1/traces`} serviceName={project.slug} />
      }
      contextPanel={
        data.context ? (
          <ContextPanel subtitle={`Tokens sent to the model, last ${window} days`}>
            <ContextBreakdown
              split={data.context.split}
              suggestions={data.context.suggestions}
              promptCacheHitRate={data.context.promptCacheHitRate}
            />
          </ContextPanel>
        ) : null
      }
    />
  );
}
