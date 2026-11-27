import { and, eq } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import type { BaselineStore } from "../ports/baseline-store";
import { evalBaselines, evalPinnedBaselines } from "../schema";

type Db = Pick<ReturnType<typeof getDb>, "select" | "insert" | "delete">;

const PIN = {
  experimentId: evalPinnedBaselines.experimentId,
  pinnedBy: evalPinnedBaselines.pinnedBy,
  pinnedAt: evalPinnedBaselines.pinnedAt,
};

export function createDrizzleBaselineStore(db: Db): BaselineStore {
  return {
    async get(projectId, evalId = null) {
      if (evalId) {
        const [row] = await db
          .select(PIN)
          .from(evalPinnedBaselines)
          .where(
            and(
              eq(evalPinnedBaselines.projectId, projectId),
              eq(evalPinnedBaselines.evalId, evalId),
            ),
          );
        return row ?? null;
      }
      const [row] = await db
        .select({
          experimentId: evalBaselines.experimentId,
          pinnedBy: evalBaselines.pinnedBy,
          pinnedAt: evalBaselines.pinnedAt,
        })
        .from(evalBaselines)
        .where(eq(evalBaselines.projectId, projectId));
      return row ?? null;
    },

    async pin(projectId, baseline, evalId = null) {
      if (evalId) {
        await db
          .insert(evalPinnedBaselines)
          .values({ evalId, projectId, ...baseline })
          .onConflictDoUpdate({ target: evalPinnedBaselines.evalId, set: baseline });
        return;
      }
      await db
        .insert(evalBaselines)
        .values({ projectId, ...baseline })
        .onConflictDoUpdate({ target: evalBaselines.projectId, set: baseline });
    },

    async unpin(projectId, experimentId, evalId = null) {
      if (evalId) {
        const rows = await db
          .delete(evalPinnedBaselines)
          .where(
            and(
              eq(evalPinnedBaselines.projectId, projectId),
              eq(evalPinnedBaselines.evalId, evalId),
              experimentId ? eq(evalPinnedBaselines.experimentId, experimentId) : undefined,
            ),
          )
          .returning({ evalId: evalPinnedBaselines.evalId });
        return rows.length > 0;
      }
      const rows = await db
        .delete(evalBaselines)
        .where(
          and(
            eq(evalBaselines.projectId, projectId),
            experimentId ? eq(evalBaselines.experimentId, experimentId) : undefined,
          ),
        )
        .returning({ projectId: evalBaselines.projectId });
      return rows.length > 0;
    },

    async ofEvals(projectId) {
      const rows = await db
        .select({ evalId: evalPinnedBaselines.evalId, ...PIN })
        .from(evalPinnedBaselines)
        .where(eq(evalPinnedBaselines.projectId, projectId));
      return new Map(rows.map(({ evalId, ...baseline }) => [evalId, baseline]));
    },
  };
}
