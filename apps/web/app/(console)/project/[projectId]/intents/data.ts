import { requireProjectScope } from "@/lib/console/scope/project-scope";
import { isDbConfigured } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import {
  loadStoredTopics,
  loadTaskRuns,
  loadTopicReading,
  topicReadingInFlight,
} from "@/lib/readings/topics/queries";
import { loadWorkflowLabels } from "@/lib/readings/trace-signals/workflows/label-queries";
import { absoluteTime, timeAgo } from "@/lib/views/intents/map/labels";
import type { IntentMapModel } from "@/lib/views/intents/map/map-model";
import { loadToolSteps } from "@/lib/views/intents/map/queries";
import type { ToolStep } from "@/lib/views/intents/map/tool-network";
import { topicMapModel } from "@/lib/views/intents/topics-map-model";
import { buildTopicsView, type IntentsReading } from "@/lib/views/intents/topics-view";

/**
 * What the Intents pages read: the latest topic reading (`assign_topics`), the
 * stored topic names, and the task names and colors the topics link to. One
 * bounded read (`withStatementTimeout` inside `loadOrFallback`): when it fails
 * or runs long the page says so in place and the rest of the shell works.
 *
 * Owned (ADR-0030): the project comes from the console scope (the session's
 * organization, a 404 otherwise).
 */

export type IntentsPageData =
  | { kind: "no-db" }
  | { kind: "ready"; projectId: string; reading: IntentsReading };

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function loadIntentsPage(projectIdParam: string): Promise<IntentsPageData> {
  if (!isDbConfigured()) return { kind: "no-db" };
  const { project } = await requireProjectScope(projectIdParam);
  const projectId = project.id;
  const operation = "topics_reading";
  const read = await loadOrFallback({
    operation,
    distinctId: `project:${projectId}`,
    fallback: null,
    load: () =>
      withStatementTimeout(
        async (db) => {
          const reading = await loadTopicReading(projectId, db);
          const inFlight = await topicReadingInFlight(projectId, db);
          if (!reading)
            return { reading: null, inFlight, topics: [], tasks: [], labels: new Map() };
          const topics = await loadStoredTopics(projectId, db);
          const tasks = await loadTaskRuns(projectId, db);
          const labels = await loadWorkflowLabels(projectId, db);
          return { reading, inFlight, topics, tasks, labels };
        },
        { operation },
      ),
  });
  if (!read) return { kind: "ready", projectId, reading: { status: "failed" } };
  if (!read.reading) {
    return { kind: "ready", projectId, reading: { status: "none", inFlight: read.inFlight } };
  }
  const { insights, computedAt } = read.reading;
  const view = buildTopicsView({
    projectId,
    insights,
    topics: read.topics,
    tasks: read.tasks,
    taskLabels: read.labels,
  });
  return {
    kind: "ready",
    projectId,
    reading: {
      status: "ready",
      view,
      flows: insights.flows,
      flowsBlocked: insights.flowsBlocked,
      lanes: insights.lanes ?? null,
      tools: insights.tools,
      turns: insights.turns,
      modelOnlyTurns: insights.modelOnlyTurns ?? 0,
      read: { relative: timeAgo(computedAt), absolute: absoluteTime(computedAt) },
      inFlight: read.inFlight,
    },
  };
}

/**
 * The Map's model from a reading, and the "came next" steps between its tools
 * from the latest tool reading, a bonus bounded on its own: when it fails (or,
 * here, while the tool explorer has not landed) the Tools view draws no arrows.
 */
export async function loadTopicMap(
  projectId: string,
  reading: Extract<IntentsReading, { status: "ready" }>,
): Promise<{ model: IntentMapModel; steps: ToolStep[] }> {
  const model = topicMapModel(reading.view, reading.tools);
  const keep = new Set(model.capabilities.map((capability) => capability.id));
  const steps =
    keep.size > 1
      ? await loadOrFallback<ToolStep[]>({
          operation: "topics_tool_steps",
          distinctId: `project:${projectId}`,
          fallback: [],
          load: () => loadToolSteps({ projectId, keep }),
        })
      : [];
  return { model, steps };
}
