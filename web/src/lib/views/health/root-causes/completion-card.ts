import { and, count, eq, gte, lt } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { traceTaskOutcomes } from "@/lib/readings/trace-signals/schema";
import type { WindowDays } from "@/lib/readings/trace-signals/view";
import {
  rootCausesHref,
  TASK_FILTERS,
  type TaskFilter,
  taskFilterOf,
} from "@/lib/views/traces/sentiment/page-paths";
import type { PageDb } from "@/lib/views/traces/sentiment/page-queries";

/**
 * Task completion on Agent health's Summary: the window's tasks by status,
 * as shares. A task whose result can't be told is left out, as on the pages
 * it leads to. The two statuses that need explaining (completed after
 * friction, not completed) open Root cause analysis narrowed to them.
 */

export interface TaskCompletionCard {
  windowDays: WindowDays;
  total: number;
  statuses: Array<{ filter: TaskFilter; tasks: number; share: number; href: string | null }>;
  /** Root cause analysis for the window, every reason. */
  href: string;
}

const DAY_MS = 86_400_000;
const EXPLAINED: readonly TaskFilter[] = ["completed_after_friction", "not_completed"];

/** The card from task counts by stored result (pure). */
export function taskCompletionCard(
  projectId: string,
  windowDays: WindowDays,
  counts: ReadonlyArray<{ result: string; tasks: number }>,
): TaskCompletionCard {
  const byFilter = new Map<TaskFilter, number>();
  for (const row of counts) {
    const filter = taskFilterOf(row);
    if (filter) byFilter.set(filter, (byFilter.get(filter) ?? 0) + row.tasks);
  }
  const total = [...byFilter.values()].reduce((sum, n) => sum + n, 0);
  return {
    windowDays,
    total,
    statuses: TASK_FILTERS.map((filter) => {
      const tasks = byFilter.get(filter) ?? 0;
      return {
        filter,
        tasks,
        share: total === 0 ? 0 : tasks / total,
        href:
          EXPLAINED.includes(filter) && tasks > 0
            ? rootCausesHref(projectId, { days: windowDays, filters: { task: filter } })
            : null,
      };
    }),
    href: rootCausesHref(projectId, { days: windowDays }),
  };
}

export async function loadTaskCompletionCard(
  projectId: string,
  windowDays: WindowDays,
  db: PageDb = getDb(),
  now: Date = new Date(),
): Promise<TaskCompletionCard> {
  const rows = await db
    .select({ result: traceTaskOutcomes.result, tasks: count() })
    .from(traceTaskOutcomes)
    .where(
      and(
        eq(traceTaskOutcomes.projectId, projectId),
        gte(traceTaskOutcomes.endedAt, new Date(now.getTime() - windowDays * DAY_MS)),
        lt(traceTaskOutcomes.endedAt, now),
      ),
    )
    .groupBy(traceTaskOutcomes.result);
  return taskCompletionCard(projectId, windowDays, rows);
}
