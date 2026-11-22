import { Suspense } from "react";
import { ContextBreakdown } from "@/components/console/home/ContextBreakdown";
import { ContextPanel } from "@/components/console/home/ContextPanel";
import { OverviewView } from "@/components/console/home/OverviewView";
import { PivotBreakdown, PivotBreakdownLoading } from "@/components/console/home/PivotBreakdown";
import { SetupGuide } from "@/components/console/home/SetupGuide";
import { TourLauncher } from "@/components/console/onboarding/TourLauncher";
import { BASE_URL } from "@/lib/platform/app-config";
import { loadPivotFilterOptions } from "@/lib/synthesis/pivots/filter-options";
import { pickGroupPivot } from "@/lib/synthesis/pivots/group-by-view";
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
  pivot: pivotParam,
  offerTour,
  inSupportSession,
}: {
  project: OverviewProject;
  organization: LoadOrganization;
  range: string | string[] | undefined;
  /** `?pivot=`: the pivot of the group-by table (RC-886). */
  pivot?: string | string[] | undefined;
  offerTour: boolean;
  inSupportSession: boolean;
}) {
  const window = parseOverviewWindow(range);
  const now = new Date();
  // RC-886: one `FF_PIVOTS` check. Off, or with no pivot, Overview is as before.
  const [data, pivots] = await Promise.all([
    loadOverview({ project, organization, window, now }),
    loadPivotFilterOptions(project.id, organization),
  ]);
  const pivot = pickGroupPivot(pivots, pivotParam);
  return (
    <OverviewView
      data={data}
      now={now}
      pivotBreakdown={
        pivot ? (
          <Suspense
            key={`${pivot.key}:${window}`}
            fallback={<PivotBreakdownLoading pivot={pivot} />}
          >
            <PivotBreakdown
              projectId={project.id}
              root={data.root}
              window={window}
              pivots={pivots}
              pivot={pivot}
              now={now}
            />
          </Suspense>
        ) : undefined
      }
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
          root={data.root}
          endpoint={`${BASE_URL}/v1/traces`}
          serviceName={project.slug}
          deployVersion
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
