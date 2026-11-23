import {
  loadTopicExamplesAction,
  requestTopicReadingAction,
} from "@/app/(console)/project/[projectId]/intents/actions";
import { loadIntentsPage } from "@/app/(console)/project/[projectId]/intents/data";
import { FlowsView } from "@/components/console/intents/FlowsView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";

export const metadata = { title: "Flows · Intents" };

/** Intents › Flows: what people ask next, turn by turn. */
export default async function FlowsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const data = await loadIntentsPage(projectId);
  if (data.kind === "no-db")
    return (
      <DatabaseUnavailable title="Flows">
        Flows become available once setup finishes.
      </DatabaseUnavailable>
    );
  return (
    <FlowsView
      projectId={data.projectId}
      reading={data.reading}
      loadExamples={loadTopicExamplesAction.bind(null, data.projectId)}
      requestReading={requestTopicReadingAction.bind(null, data.projectId)}
    />
  );
}
