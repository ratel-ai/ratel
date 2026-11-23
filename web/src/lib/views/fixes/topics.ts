import { and, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { traceTurnSteps, traceTurns } from "@/lib/ledger/schema";
import { getDb } from "@/lib/platform/db/client";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";
import { traceTopics, traceTurnTopics } from "@/lib/readings/topics/schema";
import type { TopicInput } from "@/lib/views/fixes/build";

/**
 * Which topics a fix serves: the share of each topic's turns that ran each
 * tool and each task, read from the turns Intents placed in topics
 * (`trace_turn_topics`, written by `assign_topics`). Before that job has run
 * there are no topics and this reads nothing.
 */

/** Topics read over this many days, like Intents' Topics. */
export const TOPIC_WINDOW_DAYS = 30;

type Db = Pick<BoundReadDb, "select">;

interface Counted {
  topicId: string | null;
  turns: number;
}

/** The read's rows as topics with their tool and task shares. Pure. */
export function topicInputs(input: {
  topics: readonly { id: string; name: string }[];
  turns: readonly Counted[];
  tools: readonly (Counted & { toolId: string | null })[];
  tasks: readonly (Counted & { taskId: string | null })[];
}): TopicInput[] {
  const totals = new Map(
    input.turns.filter((row) => row.topicId).map((row) => [row.topicId!, row.turns]),
  );
  const share = (topicId: string | null, turns: number) => {
    const total = topicId ? (totals.get(topicId) ?? 0) : 0;
    return total > 0 ? Math.min(1, turns / total) : 0;
  };
  return input.topics
    .map((topic) => ({
      id: topic.id,
      label: topic.name,
      turns: totals.get(topic.id) ?? 0,
      toolShares: Object.fromEntries(
        input.tools
          .filter((row) => row.topicId === topic.id && row.toolId)
          .map((row) => [row.toolId!, share(row.topicId, row.turns)]),
      ),
      taskShares: Object.fromEntries(
        input.tasks
          .filter((row) => row.topicId === topic.id && row.taskId)
          .map((row) => [row.taskId!, share(row.topicId, row.turns)]),
      ),
    }))
    .filter((topic) => topic.turns > 0);
}

/** Every live topic with the share of its recent turns that ran each tool and each task. */
export async function loadTopicInputs(
  projectId: string,
  db: Db = getDb(),
  now: Date = new Date(),
): Promise<TopicInput[]> {
  const topics = await db
    .select({ id: traceTopics.topicId, name: traceTopics.name })
    .from(traceTopics)
    .where(and(eq(traceTopics.projectId, projectId), isNull(traceTopics.retiredAt)));
  if (topics.length === 0) return [];
  const since = new Date(now.getTime() - TOPIC_WINDOW_DAYS * 86_400_000);
  const inWindow = and(
    eq(traceTurnTopics.projectId, projectId),
    isNotNull(traceTurnTopics.topicId),
    gte(traceTurnTopics.startedAt, since),
  );
  // One after another: the reads share one transaction (and its statement timeout), and a client runs one query at a time.
  const turns = await db
    .select({ topicId: traceTurnTopics.topicId, turns: sql<number>`count(*)::int` })
    .from(traceTurnTopics)
    .where(inWindow)
    .groupBy(traceTurnTopics.topicId);
  const tools = await db
    .select({
      topicId: traceTurnTopics.topicId,
      toolId: traceTurnSteps.targetId,
      turns: sql<number>`count(distinct ${traceTurnTopics.turnId})::int`,
    })
    .from(traceTurnTopics)
    .innerJoin(traceTurnSteps, eq(traceTurnSteps.turnId, traceTurnTopics.turnId))
    .where(
      and(
        inWindow,
        eq(traceTurnSteps.kind, "invoke"),
        eq(traceTurnSteps.targetType, "tool"),
        isNotNull(traceTurnSteps.targetId),
      ),
    )
    .groupBy(traceTurnTopics.topicId, traceTurnSteps.targetId);
  const tasks = await db
    .select({
      topicId: traceTurnTopics.topicId,
      taskId: traceTurns.workflowId,
      turns: sql<number>`count(*)::int`,
    })
    .from(traceTurnTopics)
    .innerJoin(traceTurns, eq(traceTurns.id, traceTurnTopics.turnId))
    .where(and(inWindow, isNotNull(traceTurns.workflowId)))
    .groupBy(traceTurnTopics.topicId, traceTurns.workflowId);
  return topicInputs({ topics, turns, tools, tasks });
}
