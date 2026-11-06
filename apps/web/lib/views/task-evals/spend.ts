import { and, eq, sql } from "drizzle-orm";
import { projects } from "@/lib/platform/projects/schema";
import type { EvalDb } from "@/lib/views/eval-gate/runs";
import { evalGateSeams } from "@/lib/views/eval-gate/seams";
import { taskScoresDaily } from "@/lib/views/task-scorers/schema";

/**
 * The task loop's share of the organization's one daily model budget, read through
 * `evalGateSeams.spendSince`. Owned (ADR-0030): upstream sums the same queries inline in
 * `organizationModelSpendSince` (`lib/eval-gate/store.ts`). Loaded for its side effect by the
 * registrations (the worker and the drain) and by the modules that check the budget in a
 * request, so every process that reads the budget counts the task loop.
 */

const sameOrganization = (projectId: string) =>
  sql`${projects.organizationId} = (select ${projects.organizationId} from ${projects} where ${projects.id} = ${projectId})`;

/** The live judge's daily spend, held reservations included (RC-80). */
export async function taskJudgeSpendSince(
  projectId: string,
  since: Date,
  db: EvalDb,
): Promise<number> {
  const [row] = await db
    .select({
      usd: sql<
        string | number | null
      >`coalesce(sum((${taskScoresDaily.judgeSpend}->>'usd')::numeric), 0)`,
    })
    .from(taskScoresDaily)
    .innerJoin(projects, eq(projects.id, taskScoresDaily.projectId))
    .where(
      and(
        sameOrganization(projectId),
        sql`${taskScoresDaily.day} >= ${since.toISOString().slice(0, 10)}::date`,
      ),
    );
  return Number(row?.usd ?? 0);
}

export const taskLoopSpendReaders = [taskJudgeSpendSince];

for (const read of taskLoopSpendReaders) {
  if (!evalGateSeams.spendSince.includes(read)) evalGateSeams.spendSince.push(read);
}
