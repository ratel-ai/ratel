import { and, asc, eq, gte, lte } from "drizzle-orm";
import {
  supplementaryReadTimeoutMs,
  withStatementTimeout,
} from "@/lib/platform/db/statement-timeout";
import { loadOrFallback } from "@/lib/platform/resilient-read";
import { taskScoresDaily } from "@/lib/views/task-scorers/schema";
import type { TasksLoadDeps } from "@/lib/views/tasks/page-model";

export interface TaskLiveScore {
  rate: number | null;
  runs: number;
  /** Fourteen UTC days, oldest first. A null value means no scored runs. */
  history: (number | null)[];
}

const HISTORY_DAYS = 14;
const DAY_MS = 86_400_000;
const defaultRead: TasksLoadDeps["read"] = (operation, read) =>
  withStatementTimeout(read, { operation, timeoutMs: supplementaryReadTimeoutMs() });

/** Read overall scores for every task in one bounded query. Callers enforce cloud-eval-gate. */
export async function loadTaskScores(
  projectId: string,
  now: Date,
  overrides: Pick<Partial<TasksLoadDeps>, "read"> = {},
): Promise<Map<string, TaskLiveScore> | null> {
  const today = now.toISOString().slice(0, 10);
  const end = Date.parse(today);
  const days = Array.from({ length: HISTORY_DAYS }, (_, index) =>
    new Date(end - (HISTORY_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10),
  );
  return loadOrFallback<Map<string, TaskLiveScore> | null>({
    operation: "tasks_live_scores",
    distinctId: `project:${projectId}`,
    fallback: null,
    load: async () => {
      const rows = await (overrides.read ?? defaultRead)(
        "tasks_live_scores",
        (db) =>
          db
            .select({
              taskId: taskScoresDaily.taskId,
              day: taskScoresDaily.day,
              n: taskScoresDaily.n,
              passed: taskScoresDaily.passed,
            })
            .from(taskScoresDaily)
            .where(
              and(
                eq(taskScoresDaily.projectId, projectId),
                eq(taskScoresDaily.scorerKind, "overall"),
                gte(taskScoresDaily.day, days[0]!),
                lte(taskScoresDaily.day, today),
              ),
            )
            .orderBy(asc(taskScoresDaily.day)),
        true,
      );
      const scores = new Map<string, TaskLiveScore>();
      for (const row of rows) {
        const score: TaskLiveScore = scores.get(row.taskId) ?? {
          rate: null,
          runs: 0,
          history: days.map(() => null),
        };
        const rate = row.n > 0 ? row.passed / row.n : null;
        score.history[days.indexOf(row.day)] = rate;
        if (row.day === today) {
          score.rate = rate;
          score.runs = row.n;
        }
        scores.set(row.taskId, score);
      }
      return scores;
    },
  });
}
