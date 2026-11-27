import { and, eq, sql } from "drizzle-orm";
import { projects } from "@/lib/platform/projects/schema";
import type { EvalDb } from "@/lib/views/eval-gate/runs";
import { evalGateSeams } from "@/lib/views/eval-gate/seams";
import { scorerJudgeSpend } from "./schema";

/**
 * The judge scorers' share of the organization's one daily model budget, held reservations
 * included, read through `evalGateSeams.spendSince`. Loaded for its side effect.
 */
export async function scorerJudgeSpendSince(
  projectId: string,
  since: Date,
  db: EvalDb,
): Promise<number> {
  const [row] = await db
    .select({ usd: sql<number>`coalesce(sum(${scorerJudgeSpend.usd}), 0)::float8` })
    .from(scorerJudgeSpend)
    .innerJoin(projects, eq(projects.id, scorerJudgeSpend.projectId))
    .where(
      and(
        sql`${projects.organizationId} = (select ${projects.organizationId} from ${projects} where ${projects.id} = ${projectId})`,
        sql`${scorerJudgeSpend.day} >= ${since.toISOString().slice(0, 10)}::date`,
      ),
    );
  return Number(row?.usd ?? 0);
}

if (!evalGateSeams.spendSince.includes(scorerJudgeSpendSince)) {
  evalGateSeams.spendSince.push(scorerJudgeSpendSince);
}
