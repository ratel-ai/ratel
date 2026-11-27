import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/platform/db/client";

/**
 * Holds the project's lock for `scope` until the transaction ends. A limit counted under it is the
 * count that the transaction's insert sees: two creates at the same time never pass the limit.
 */
export async function lockProjectScope(
  tx: Pick<ReturnType<typeof getDb>, "execute">,
  scope: string,
  projectId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${scope}:${projectId}`}, 0))`,
  );
}
