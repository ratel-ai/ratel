import { ContextBreakdown } from "@/components/console/home/ContextBreakdown";
import { ContextPanel } from "@/components/console/home/ContextPanel";
import { OverviewView } from "@/components/console/home/OverviewView";
import { SetupGuide } from "@/components/console/home/SetupGuide";
import { TourLauncher } from "@/components/console/onboarding/TourLauncher";
import { loadApiKeyCta } from "@/lib/console/api-key-cta-load";
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
  // The key is read beside the data: the setup guide shows it until the first event.
  const [data, apiKey] = await Promise.all([
    loadOverview({ project, organization, window, now }),
    loadApiKeyCta(project.id, now),
  ]);
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
        <SetupGuide apiKey={apiKey} endpoint={`${BASE_URL}/v1/traces`} serviceName={project.slug} />
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
