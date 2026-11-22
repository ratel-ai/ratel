import { and, eq, sql } from "drizzle-orm";
import { projects } from "@/lib/platform/projects/schema";
import type { EvalDb } from "@/lib/views/eval-gate/runs";
import { evalGateSeams } from "@/lib/views/eval-gate/seams";
import { evalRuns } from "./schema";

/**
 * Evals' share of the organization's one daily model budget (RC-289), read through
 * `evalGateSeams.spendSince`. Owned (ADR-0030): upstream sums the same query inline in
 * `organizationModelSpendSince` (`lib/eval-gate/store.ts`). Loaded for its side effect by
 * `job.ts`, `simulation.ts` and `register.ts`, so every process that checks the budget counts
 * eval set runs.
 */

/** Eval set runs of the project's organization: finished since `since`, and live ones at what they hold. */
export async function evalSetSpendSince(
  projectId: string,
  since: Date,
  db: EvalDb,
): Promise<number> {
  const [evalSet] = await db
    .select({
      usd: sql<string | number | null>`coalesce(sum((${evalRuns.spend}->>'usd')::numeric), 0)`,
    })
    .from(evalRuns)
    .innerJoin(projects, eq(projects.id, evalRuns.projectId))
    .where(
      and(
        sql`${projects.organizationId} = (select ${projects.organizationId} from ${projects} where ${projects.id} = ${projectId})`,
        sql`(coalesce(${evalRuns.finishedAt}, ${evalRuns.createdAt}) >= ${since.toISOString()}::timestamptz or ${evalRuns.status} in ('queued', 'running'))`,
      ),
    );
  return Number(evalSet?.usd ?? 0);
}

if (!evalGateSeams.spendSince.includes(evalSetSpendSince)) {
  evalGateSeams.spendSince.push(evalSetSpendSince);
}
