import { eq } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";
import type { BaselineStore } from "../ports/baseline-store";
import { evalBaselines } from "../schema";

type Db = Pick<ReturnType<typeof getDb>, "select" | "insert" | "delete">;

export function createDrizzleBaselineStore(db: Db): BaselineStore {
  return {
    async get(projectId) {
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

    async pin(projectId, baseline) {
      await db
        .insert(evalBaselines)
        .values({ projectId, ...baseline })
        .onConflictDoUpdate({ target: evalBaselines.projectId, set: baseline });
    },

    async unpin(projectId) {
      const rows = await db
        .delete(evalBaselines)
        .where(eq(evalBaselines.projectId, projectId))
        .returning({ projectId: evalBaselines.projectId });
      return rows.length > 0;
    },
  };
}
