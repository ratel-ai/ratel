import { and, desc, eq, sql } from "drizzle-orm";
import { STALE_JOB_MS } from "@/lib/jobs/queries";
import { getDb } from "@/lib/platform/db/client";
import { projects } from "@/lib/platform/projects/schema";
import { parseChange } from "@/lib/views/eval-gate/change";
import type { EvalDb } from "@/lib/views/eval-gate/runs";
import { lockOrganizationSpend, organizationModelSpendSince } from "@/lib/views/eval-gate/store";
import { fixDrafts } from "@/lib/views/fix-drafts/schema";

/** Read the newest draft in this project. */
export async function latestFixDraft(projectId: string, fixId: string, db: EvalDb = getDb()) {
  const [row] = await db
    .select()
    .from(fixDrafts)
    .where(and(eq(fixDrafts.projectId, projectId), eq(fixDrafts.fixId, fixId)))
    .orderBy(desc(fixDrafts.createdAt), desc(fixDrafts.id))
    .limit(1);
  return row ? { ...row, change: parseChange(row.change) } : null;
}

/**
 * Reserve the full draft cap under the organization lock. Other drafts see this reservation.
 * Owned (ADR-0030): the lock is `lockOrganizationSpend`, as the core has no organizations table.
 */
export async function reserveFixDraft(
  input: {
    projectId: string;
    fixId: string;
    model: string;
    capUsd: number;
    dailyBudgetUsd: number;
    now: Date;
    actor: string;
  },
  db: ReturnType<typeof getDb>,
) {
  return db.transaction(async (tx) => {
    if (!(await lockOrganizationSpend(input.projectId, tx)))
      throw new Error("The draft project does not exist.");
    const latest = await latestFixDraft(input.projectId, input.fixId, tx);
    if (latest?.status === "ready") return { row: latest, created: false };
    if (latest?.status === "drafting") {
      if (latest.createdAt.getTime() > input.now.getTime() - STALE_JOB_MS)
        return { row: latest, created: false };
      await tx.update(fixDrafts).set({ status: "failed" }).where(eq(fixDrafts.id, latest.id));
    }
    const spent = await organizationModelSpendSince(
      input.projectId,
      new Date(input.now.getTime() - 86_400_000),
      tx,
    );
    const allowed = input.capUsd > 0 && spent + input.capUsd <= input.dailyBudgetUsd;
    const [row] = await tx
      .insert(fixDrafts)
      .values({
        projectId: input.projectId,
        fixId: input.fixId,
        model: input.model,
        createdBy: input.actor,
        createdAt: input.now,
        status: allowed ? "drafting" : "budget_refused",
        spend: { usd: allowed ? input.capUsd : 0, reserved: allowed },
      })
      .returning();
    return { row: { ...row, change: parseChange(row.change) }, created: true };
  });
}

/**
 * What this organization's drafts spent since `since`, counting every reservation still held.
 * Upstream sums it inside `eval-gate/store.ts#organizationModelSpendSince`; here it is a reader
 * on `evalGateSeams.spendSince`, which `register.ts` adds.
 */
export async function fixDraftSpendSince(
  projectId: string,
  since: Date,
  db: EvalDb = getDb(),
): Promise<number> {
  const [drafts] = await db
    .select({
      usd: sql<string | number | null>`coalesce(sum((${fixDrafts.spend}->>'usd')::numeric), 0)`,
    })
    .from(fixDrafts)
    .innerJoin(projects, eq(projects.id, fixDrafts.projectId))
    .where(
      and(
        sql`${projects.organizationId} = (select ${projects.organizationId} from ${projects} where ${projects.id} = ${projectId})`,
        sql`(${fixDrafts.createdAt} >= ${since.toISOString()}::timestamptz or ${fixDrafts.status} = 'drafting')`,
      ),
    );
  return Number(drafts?.usd ?? 0);
}
