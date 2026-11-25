import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import type { JudgeBudget } from "../ports/judge-budget";
import { evalJudgeSpend } from "../schema";

type Db = Pick<ReturnType<typeof getDb>, "insert" | "update">;

export function createDrizzleJudgeBudget(db: Db): JudgeBudget {
  return {
    async hold(organizationId, day, usd, maxUsd) {
      if (usd > maxUsd) return false;
      // One statement: two holds at the same time cannot both take the last of the budget.
      const held = await db
        .insert(evalJudgeSpend)
        .values({ organizationId, day, usd })
        .onConflictDoUpdate({
          target: [evalJudgeSpend.organizationId, evalJudgeSpend.day],
          set: { usd: sql`${evalJudgeSpend.usd} + excluded.usd` },
          setWhere: sql`${evalJudgeSpend.usd} + excluded.usd <= ${maxUsd}`,
        })
        .returning({ usd: evalJudgeSpend.usd });
      return held.length > 0;
    },

    async settle(organizationId, day, heldUsd, spentUsd) {
      await db
        .update(evalJudgeSpend)
        .set({
          usd: sql`greatest(0, ${evalJudgeSpend.usd} - ${heldUsd}::double precision + ${spentUsd}::double precision)`,
        })
        .where(and(eq(evalJudgeSpend.organizationId, organizationId), eq(evalJudgeSpend.day, day)));
    },
  };
}
