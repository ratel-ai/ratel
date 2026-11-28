import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { SandboxVersionHolds } from "@/lib/contracts/sandbox-version-holds";
import { getDb } from "@/lib/platform/db/client";
import { evalBaselines, evalExperiments } from "./schema";

type Db = Pick<ReturnType<typeof getDb>, "selectDistinct">;

/**
 * The sandbox versions that evals need, so the sandbox snapshot sweep keeps their snapshots: the
 * version of each running experiment (its trials still start runs), and the version of the
 * experiment of each pinned baseline (a person can run it again to compare). The composition root
 * gives it to the sandboxes module (`lib/composition/registry.ts`).
 */
export function createEvalSandboxVersionHolds(db: Db): SandboxVersionHolds {
  return async (versionIds) => {
    if (versionIds.length === 0) return new Set();
    const rows = await db
      .selectDistinct({ id: evalExperiments.sandboxVersionId })
      .from(evalExperiments)
      .where(
        and(
          inArray(evalExperiments.sandboxVersionId, [...versionIds]),
          or(
            eq(evalExperiments.state, "running"),
            sql`exists (select 1 from ${evalBaselines} where ${evalBaselines.experimentId} = ${evalExperiments.id})`,
          ),
        ),
      );
    return new Set(rows.map((row) => row.id));
  };
}

/** The holds of evals over the real database. */
export const evalSandboxVersionHolds: SandboxVersionHolds = (versionIds) =>
  createEvalSandboxVersionHolds(getDb())(versionIds);
