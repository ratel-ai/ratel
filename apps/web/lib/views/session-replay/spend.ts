import { and, eq, sql } from "drizzle-orm";
import { projects } from "@/lib/platform/projects/schema";
import type { EvalDb } from "@/lib/views/eval-gate/runs";
import { evalGateSeams } from "@/lib/views/eval-gate/seams";
import { sessionReplayRuns } from "./schema";

/**
 * What-if's share of the organization's one daily model budget (RC-176), read through
 * `evalGateSeams.spendSince`. Owned (ADR-0030): upstream sums the same query inline in
 * `organizationModelSpendSince` (`lib/eval-gate/store.ts`). Loaded for its side effect by
 * `register.ts` (the worker and the drain) and `runs.ts` (a request), so every process that
 * checks the budget counts What-if.
 */

/** What-if runs of the project's organization: finished since `since`, and live ones at what they hold. */
export async function whatIfSpendSince(
  projectId: string,
  since: Date,
  db: EvalDb,
): Promise<number> {
  // RC-176: What-if runs, live ones at what they hold.
  const [whatIf] = await db
    .select({
      usd: sql<
        string | number | null
      >`coalesce(sum((${sessionReplayRuns.spend}->>'usd')::numeric), 0)`,
    })
    .from(sessionReplayRuns)
    .innerJoin(projects, eq(projects.id, sessionReplayRuns.projectId))
    .where(
      and(
        sql`${projects.organizationId} = (select ${projects.organizationId} from ${projects} where ${projects.id} = ${projectId})`,
        sql`(coalesce(${sessionReplayRuns.finishedAt}, ${sessionReplayRuns.createdAt}) >= ${since.toISOString()}::timestamptz or ${sessionReplayRuns.status} in ('queued', 'running'))`,
      ),
    );
  return Number(whatIf?.usd ?? 0);
}

if (!evalGateSeams.spendSince.includes(whatIfSpendSince)) {
  evalGateSeams.spendSince.push(whatIfSpendSince);
}
