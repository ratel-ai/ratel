import { and, eq, isNull } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import type { BaselineStore } from "../ports/baseline-store";
import { evalBaselines } from "../schema";

type Db = Pick<ReturnType<typeof getDb>, "select" | "insert" | "delete">;

export function createDrizzleBaselineStore(db: Db): BaselineStore {
  return {
    async get(projectId, evalId = null) {
      const [row] = await db
        .select({
          evalId: evalBaselines.evalId,
          experimentId: evalBaselines.experimentId,
          pinnedBy: evalBaselines.pinnedBy,
          pinnedAt: evalBaselines.pinnedAt,
        })
        .from(evalBaselines)
        .where(and(eq(evalBaselines.projectId, projectId), ofEval(evalId)));
      return row ?? null;
    },

    async pin(projectId, baseline) {
      const { experimentId, pinnedBy, pinnedAt } = baseline;
      await db
        .insert(evalBaselines)
        .values({ projectId, ...baseline })
        .onConflictDoUpdate({
          target: [evalBaselines.projectId, evalBaselines.evalId],
          set: { experimentId, pinnedBy, pinnedAt },
        });
    },

    async unpin(projectId, experimentId) {
      const rows = await db
        .delete(evalBaselines)
        .where(
          and(
            eq(evalBaselines.projectId, projectId),
            experimentId ? eq(evalBaselines.experimentId, experimentId) : ofEval(null),
          ),
        )
        .returning({ projectId: evalBaselines.projectId });
      return rows.length > 0;
    },
  };
}

function ofEval(evalId: string | null) {
  return evalId === null ? isNull(evalBaselines.evalId) : eq(evalBaselines.evalId, evalId);
}
