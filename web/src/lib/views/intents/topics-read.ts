import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import { loadStoredTopics, loadTaskRuns, loadTopicReading } from "@/lib/readings/topics/queries";
import { loadWorkflowLabels } from "@/lib/readings/trace-signals/workflows/label-queries";
import { buildTopicsView } from "@/lib/views/intents/topics-view";

/** The latest topic reading as the Intents pages show it, or null before the first one. */
export async function readTopics(projectId: string, db: BoundReadDb) {
  const reading = await loadTopicReading(projectId, db);
  if (!reading) return null;
  const topics = await loadStoredTopics(projectId, db);
  const tasks = await loadTaskRuns(projectId, db);
  const taskLabels = await loadWorkflowLabels(projectId, db);
  const { insights, computedAt } = reading;
  return {
    insights,
    computedAt,
    view: buildTopicsView({ projectId, insights, topics, tasks, taskLabels }),
  };
}
