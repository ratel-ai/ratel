import { ContextBreakdown } from "@/components/console/home/ContextBreakdown";
import { ContextPanel } from "@/components/console/home/ContextPanel";
import { OverviewView } from "@/components/console/home/OverviewView";
import { SetupGuide } from "@/components/console/home/SetupGuide";
import { TourLauncher } from "@/components/console/onboarding/TourLauncher";
import { hasUsableApiKey } from "@/lib/console/has-api-key";
import { BASE_URL } from "@/lib/platform/app-config";
import { loadOverview, type OverviewProject } from "@/lib/views/home/load";
import { parseOverviewWindow } from "@/lib/views/home/overview-model";

type LoadOrganization = Parameters<typeof loadOverview>[0]["organization"];

/**
 * Overview: reads its window from the URL, loads, renders. Inside an admin support session the
 * tour records nothing.
 */
export async function OverviewPage({
  project,
  organization,
  range,
  offerTour,
  inSupportSession,
}: {
  project: OverviewProject;
  organization: LoadOrganization;
  range: string | string[] | undefined;
  offerTour: boolean;
  inSupportSession: boolean;
}) {
  const window = parseOverviewWindow(range);
  const now = new Date();
  const data = await loadOverview({ project, organization, window, now });
  // The setup guide shows until the first event, and points at the key onboarding made.
  const hasApiKey = !data.hasTelemetry && (await hasUsableApiKey(project.id));
  return (
    <OverviewView
      data={data}
      now={now}
      actions={
        // The tour points at the rail, which is a drawer below md.
        <span className="max-md:hidden">
          <TourLauncher
            autoStart={offerTour}
            isDemoProject={project.isDemo}
            surface="project_home"
            record={!inSupportSession}
          />
        </span>
      }
      setup={
        <SetupGuide
          projectId={project.id}
          hasApiKey={hasApiKey}
          endpoint={`${BASE_URL}/v1/traces`}
          serviceName={project.slug}
        />
      }
      contextPanel={
        <ContextPanel subtitle={`Tokens sent to the model, last ${window} days`}>
          <ContextBreakdown
            split={data.context}
            suggestions={data.contextSuggestions}
            promptCacheHitRate={data.promptCacheHitRate}
          />
        </ContextPanel>
      }
    />
  );
}
