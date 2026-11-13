import { ContextBreakdown } from "@/components/console/home/ContextBreakdown";
import { ContextPanel } from "@/components/console/home/ContextPanel";
import { OverviewView } from "@/components/console/home/OverviewView";
import { SetupGuide } from "@/components/console/home/SetupGuide";
import { TourLauncher } from "@/components/console/onboarding/TourLauncher";
import { apiUrl } from "@/lib/platform/app-config";
import { loadOverview, type OverviewProject } from "@/lib/views/home/load";
import { parseOverviewWindow } from "@/lib/views/home/overview-model";

type LoadOrganization = Parameters<typeof loadOverview>[0]["organization"];

/**
 * Overview: reads its window from the URL, loads, renders.
 *
 * Owned (ADR-0030): no support session in this edition, so the tour always
 * records how it ended.
 */
export async function OverviewPage({
  project,
  organization,
  range,
  offerTour,
}: {
  project: OverviewProject;
  organization: LoadOrganization;
  range: string | string[] | undefined;
  offerTour: boolean;
}) {
  const window = parseOverviewWindow(range);
  const now = new Date();
  const data = await loadOverview({ project, organization, window, now });
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
          />
        </span>
      }
      setup={
        <SetupGuide root={data.root} endpoint={apiUrl("/traces")} serviceName={project.slug} />
      }
      contextPanel={
        <ContextPanel subtitle={`Tokens sent to the model, last ${window} days`}>
          <ContextBreakdown split={data.context} suggestions={data.contextSuggestions} />
        </ContextPanel>
      }
    />
  );
}
