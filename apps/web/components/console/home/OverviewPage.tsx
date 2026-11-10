import { ContextBreakdown } from "@/components/console/home/ContextBreakdown";
import { ContextPanel } from "@/components/console/home/ContextPanel";
import { OverviewView } from "@/components/console/home/OverviewView";
import { SetupGuide } from "@/components/console/home/SetupGuide";
import { apiUrl } from "@/lib/platform/app-config";
import { loadOverview, type OverviewProject } from "@/lib/views/home/load";
import { parseOverviewWindow } from "@/lib/views/home/overview-model";

type LoadOrganization = Parameters<typeof loadOverview>[0]["organization"];

/**
 * Overview: reads its window from the URL, loads, renders.
 *
 * Owned (ADR-0030): no guided tour in this edition, so the header carries no
 * launcher and the page passes no tour or support-session props.
 */
export async function OverviewPage({
  project,
  organization,
  range,
}: {
  project: OverviewProject;
  organization: LoadOrganization;
  range: string | string[] | undefined;
}) {
  const window = parseOverviewWindow(range);
  const now = new Date();
  const data = await loadOverview({ project, organization, window, now });
  return (
    <OverviewView
      data={data}
      now={now}
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
