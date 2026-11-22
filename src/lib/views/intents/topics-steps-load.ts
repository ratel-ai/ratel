import { sql } from "drizzle-orm";
import {
  type BoundReadDb,
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { parseStoredPattern } from "@/lib/readings/topics/patterns";
import { loadTaskRuns } from "@/lib/readings/topics/queries";
import { traceTopicInsights } from "@/lib/readings/topics/schema";
import { TOPIC_INSIGHTS_VERSION, type TopicStats } from "@/lib/readings/topics/types";
import { buildIntentSteps, type IntentStepsView } from "@/lib/views/intents/topics-steps";

/**
 * The Intent panel's "Step by step", read on its own: one intent's row of
 * the latest topic reading (a JSON path, not the whole reading) and the
 * latest signal run's tasks, under one short statement timeout (a panel's
 * supplementary read, like its breakdown). A failed or slow read is logged
 * and reported and reads as `failed`, so the panel says so in place; the
 * rest of it still works. A page that already holds
 * the reading calls `buildIntentSteps` directly instead.
 */

export type IntentStepsRead =
  | { status: "failed" }
  | { status: "none" }
  | { status: "ready"; steps: IntentStepsView };

type StepsStats = Pick<TopicStats, "id" | "turns" | "tasks" | "pattern">;

/** The stored row's parts this reads, or null when it does not parse (stored JSON is untrusted). */
export function parseStepsStats(raw: unknown): StepsStats | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.turns !== "number") return null;
  const tasks = Array.isArray(record.tasks)
    ? record.tasks.flatMap((task) => {
        const row = task as { id?: unknown; turns?: unknown } | null;
        return row && typeof row.id === "string" && typeof row.turns === "number"
          ? [{ id: row.id, turns: row.turns }]
          : [];
      })
    : [];
  const pattern = parseStoredPattern(record.pattern);
  return { id: record.id, turns: record.turns, tasks, ...(pattern ? { pattern } : {}) };
}

/** One intent's row of the latest reading; null without a reading or without the intent in it. */
export async function loadTopicStatsRow(
  projectId: string,
  topicId: string,
  db: Pick<BoundReadDb, "execute">,
): Promise<StepsStats | null> {
  const result = await db.execute(sql`
    select topic from ${traceTopicInsights},
      jsonb_array_elements(case when jsonb_typeof(${traceTopicInsights.data} -> 'topics') = 'array' then ${traceTopicInsights.data} -> 'topics' else '[]'::jsonb end) as topic
    where ${traceTopicInsights.projectId} = ${projectId}
      and ${traceTopicInsights.data} ->> 'version' = ${String(TOPIC_INSIGHTS_VERSION)}
      and topic ->> 'id' = ${topicId}
    limit 1
  `);
  const row = result.rows[0] as { topic?: unknown } | undefined;
  return parseStepsStats(row?.topic);
}

export async function loadIntentSteps(
  projectId: string,
  topicId: string,
  deps: { db?: BoundReadDb } = {},
): Promise<IntentStepsRead> {
  const operation = "topic_steps";
  const read = await loadOrFallback({
    operation,
    distinctId: `project:${projectId}`,
    fallback: null,
    load: () =>
      withStatementTimeout(
        async (db) => {
          const stats = await loadTopicStatsRow(projectId, topicId, db);
          // In turn: both run in one transaction, on one client.
          return { stats, tasks: stats?.pattern ? await loadTaskRuns(projectId, db) : [] };
        },
        { operation, timeoutMs: supplementaryReadTimeoutMs(), ...(deps.db ? { db: deps.db } : {}) },
      ),
  });
  if (!read) return { status: "failed" };
  const steps = read.stats ? buildIntentSteps({ stats: read.stats, tasks: read.tasks }) : null;
  return steps ? { status: "ready", steps } : { status: "none" };
}
