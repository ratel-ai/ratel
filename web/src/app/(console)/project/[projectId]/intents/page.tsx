import {
  loadIntentDetailAction,
  loadIntentLeadsAction,
  loadIntentRowsAction,
  loadTopicExamplesAction,
  requestTopicReadingAction,
} from "@/app/(console)/project/[projectId]/intents/actions";
import { loadIntentsPage } from "@/app/(console)/project/[projectId]/intents/data";
import { TopicsView } from "@/components/console/intents/TopicsView";
import { DatabaseUnavailable } from "@/components/console/shell/DatabaseUnavailable";

export const metadata = { title: "All intents · Intents" };

/** Intents › All intents: what people want from the agent, and how it goes. */
export default async function IntentsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const data = await loadIntentsPage(projectId);
  if (data.kind === "no-db")
    return (
      <DatabaseUnavailable title="All intents">
        Intents become available once setup finishes.
      </DatabaseUnavailable>
    );
  return (
    <TopicsView
      projectId={data.projectId}
      reading={data.reading}
      loadExamples={loadTopicExamplesAction.bind(null, data.projectId)}
      loadLeads={loadIntentLeadsAction.bind(null, data.projectId)}
      loadRows={loadIntentRowsAction.bind(null, data.projectId)}
      loadDetail={loadIntentDetailAction.bind(null, data.projectId)}
      requestReading={requestTopicReadingAction.bind(null, data.projectId)}
    />
  );
}
