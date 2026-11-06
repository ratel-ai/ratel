import {
  loadIntentAsksAction,
  loadIntentDetailAction,
  loadTopicExamplesAction,
  requestTopicReadingAction,
} from "@/app/(console)/project/[projectId]/intents/actions";
import { loadIntentsPage, loadTopicMap } from "@/app/(console)/project/[projectId]/intents/data";
import { MapView } from "@/components/console/intents/MapView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { loadTaskSteps, type TaskSteps } from "@/lib/views/intents/map/queries";
import { topicMapModel } from "@/lib/views/intents/topics-map-model";

export const metadata = { title: "Map · Intents" };

/**
 * Intents › Map: every intent as a blob holding the tools its asks used, the
 * same as a flow, or the tools as a globe of their tasks. The tasks' steps are
 * a bonus read of their own: when it fails, each tool's main task still gives
 * it a home and nothing is Shared.
 */
export default async function MapPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const data = await loadIntentsPage(projectId);
  if (data.kind === "no-db")
    return (
      <DatabaseUnavailable title="Map">
        The map becomes available once setup finishes.
      </DatabaseUnavailable>
    );
  const reading = data.reading;
  const loaded =
    reading.status === "ready" && reading.view.topics.length > 0
      ? await loadTopicMap(data.projectId, reading)
      : null;
  const tasks = loaded
    ? await loadOrFallback<TaskSteps[]>({
        operation: "intent_map_task_steps",
        distinctId: `project:${data.projectId}`,
        fallback: [],
        load: () => loadTaskSteps(data.projectId),
      })
    : [];
  const map =
    loaded && reading.status === "ready"
      ? { model: topicMapModel(reading.view, reading.tools, tasks), steps: loaded.steps }
      : null;
  return (
    <MapView
      projectId={data.projectId}
      reading={reading}
      map={map}
      loadExamples={loadTopicExamplesAction.bind(null, data.projectId)}
      loadDetail={loadIntentDetailAction.bind(null, data.projectId)}
      loadAsks={loadIntentAsksAction.bind(null, data.projectId)}
      requestReading={requestTopicReadingAction.bind(null, data.projectId)}
    />
  );
}
