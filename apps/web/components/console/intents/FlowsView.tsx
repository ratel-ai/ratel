import { NOUN_ICONS } from "@ratel/design-system/entity";
import { Page, PageBody, PageHeader } from "@ratel/design-system/page-header";
import { EmptyState } from "@ratel/design-system/states";
import { FlowCanvas, type FlowTopics } from "@/components/console/intents/FlowCanvas";
import {
  IntentsNoReading,
  IntentsNothingToGroup,
  IntentsReadFailed,
} from "@/components/console/intents/IntentsStates";
import type { ReadingRequest } from "@/components/console/intents/ReadNow";
import type { ExamplesLoad } from "@/components/console/intents/TopicExamples";
import { intentsCrumbs, ReadingAge } from "@/components/console/intents/TopicsView";
import { flowTaskKey } from "@/lib/readings/topics/types";
import { flowsGap, flowsNote } from "@/lib/views/intents/topics-explain";
import type { IntentsReading } from "@/lib/views/intents/topics-view";

export const FLOWS_DESCRIPTION = "What people want next, ask after ask.";

type Ready = Extract<IntentsReading, { status: "ready" }>;

/**
 * Intents › Flows: what people want across a conversation's asks, the 1st to
 * the 4th and where it ended, for everyone or for those who started in one
 * place. A step opens the tools that ran there and its examples. Works from
 * either lane: telemetry joins asks by conversation id, the SDK by session
 * and end user; when neither can be trusted, or every ask stands alone, the
 * page says so and what to send.
 */
export function FlowsView({
  projectId,
  reading,
  loadExamples,
  requestReading,
}: {
  projectId: string;
  reading: IntentsReading;
  loadExamples: ExamplesLoad;
  requestReading: ReadingRequest;
}) {
  return (
    <Page>
      <PageHeader
        crumbs={intentsCrumbs(projectId)}
        title="Flows"
        description={FLOWS_DESCRIPTION}
        actions={<ReadingAge reading={reading} />}
      />
      <PageBody wide>
        {reading.status === "failed" ? (
          <IntentsReadFailed />
        ) : reading.status === "none" ? (
          <IntentsNoReading inFlight={reading.inFlight} request={requestReading} />
        ) : (
          <FlowsBody
            projectId={projectId}
            reading={reading}
            loadExamples={loadExamples}
            requestReading={requestReading}
          />
        )}
      </PageBody>
    </Page>
  );
}

function FlowsBody({
  projectId,
  reading,
  loadExamples,
  requestReading,
}: {
  projectId: string;
  reading: Ready;
  loadExamples: ExamplesLoad;
  requestReading: ReadingRequest;
}) {
  // Nothing was read at all: the same empty state as All intents.
  if (reading.flows && reading.flows.all.sessions === 0)
    return <IntentsNothingToGroup turns={reading.turns} request={requestReading} />;
  const gap = flowsGap(reading);
  if (gap || !reading.flows) {
    return (
      <section
        aria-label="Flows unavailable"
        data-flows-gap=""
        className="rounded-lg border border-line dot-grid-fade"
      >
        <EmptyState
          icon={NOUN_ICONS.conversation}
          title={gap?.title ?? "Can't follow conversations yet"}
          description={gap?.body}
        />
      </section>
    );
  }
  return (
    <FlowCanvas
      projectId={projectId}
      flows={reading.flows}
      topics={flowTopics(reading)}
      note={flowsNote(reading)}
      loadExamples={loadExamples}
    />
  );
}

function flowTopics(reading: Ready): FlowTopics {
  const { taskNames, taskSlots } = reading.view;
  return Object.fromEntries([
    ...reading.view.topics.map(
      (topic) => [topic.id, { name: topic.name, slot: topic.slot }] as const,
    ),
    // A step with none of the ask's words is the task the agent ran.
    ...Object.entries(taskNames).map(
      ([id, name]) => [flowTaskKey(id), { name, slot: taskSlots[id] ?? null }] as const,
    ),
  ]);
}
