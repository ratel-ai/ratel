import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { LENS_DESCRIPTIONS } from "@/components/console/intent-map/lens-descriptions";
import { MapLensDescription } from "@/components/console/intent-map/MapLensDescription";
import {
  IntentsNoReading,
  IntentsNothingToGroup,
  IntentsReadFailed,
} from "@/components/console/intents/IntentsStates";
import type { ReadingRequest } from "@/components/console/intents/ReadNow";
import type { ExamplesLoad } from "@/components/console/intents/TopicExamples";
import type { IntentDetailLoad } from "@/components/console/intents/TopicPanel";
import {
  type AsksLoad,
  type MapTool,
  TopicsMapView,
} from "@/components/console/intents/TopicsMapView";
import { intentsCrumbs, ReadingAge } from "@/components/console/intents/TopicsView";
import type { IntentMapModel } from "@/lib/views/intents/map/map-model";
import { explorerCapabilityKey, type ToolStep } from "@/lib/views/intents/map/tool-network";
import type { IntentsReading } from "@/lib/views/intents/topics-view";

export const MAP_DESCRIPTION = LENS_DESCRIPTIONS.map;

/** Intents › Map: every intent as a blob holding its tools, the same as a flow, or the tools as a globe of their tasks. */
export function MapView({
  projectId,
  reading,
  map,
  loadExamples,
  loadDetail,
  loadAsks,
  requestReading,
}: {
  projectId: string;
  reading: IntentsReading;
  map: { model: IntentMapModel; steps: ToolStep[] } | null;
  loadExamples: ExamplesLoad;
  loadDetail: IntentDetailLoad;
  loadAsks: AsksLoad;
  requestReading: ReadingRequest;
}) {
  return (
    <Page>
      <PageHeader
        crumbs={intentsCrumbs(projectId)}
        title="Map"
        description={<MapLensDescription />}
        actions={<ReadingAge reading={reading} />}
      />
      <PageBody wide>
        {reading.status === "failed" ? (
          <IntentsReadFailed />
        ) : reading.status === "none" ? (
          <IntentsNoReading inFlight={reading.inFlight} request={requestReading} />
        ) : reading.view.topics.length === 0 || !map ? (
          <IntentsNothingToGroup turns={reading.turns} request={requestReading} />
        ) : (
          <TopicsMapView
            projectId={projectId}
            model={map.model}
            steps={map.steps}
            topics={reading.view.topics}
            tools={mapTools(reading)}
            loadExamples={loadExamples}
            loadDetail={loadDetail}
            loadAsks={loadAsks}
          />
        )}
      </PageBody>
    </Page>
  );
}

function mapTools(reading: Extract<IntentsReading, { status: "ready" }>): Record<string, MapTool> {
  const { taskSlots, taskNames } = reading.view;
  return Object.fromEntries(
    reading.tools.map((tool) => [
      explorerCapabilityKey(tool.id),
      {
        calls: tool.calls,
        failures: tool.failures,
        task: tool.task
          ? {
              id: tool.task,
              name: taskNames[tool.task] ?? "Unnamed task",
              slot: taskSlots[tool.task] ?? null,
            }
          : null,
      },
    ]),
  );
}
