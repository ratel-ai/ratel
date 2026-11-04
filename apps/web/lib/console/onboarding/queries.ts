import { eq } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import { sampleProjectSeeds } from "./schema";

export type SampleSeedDb = Pick<ReturnType<typeof getDb>, "insert" | "update" | "select">;

/**
 * Claim the right to seed this organization's sample project, exactly once: the insert wins
 * for the first caller and does nothing for every later one, under any concurrency.
 */
export async function claimSampleProjectSeeding(
  organizationId: string,
  at: Date,
  db: SampleSeedDb = getDb(),
): Promise<boolean> {
  const claimed = await db
    .insert(sampleProjectSeeds)
    .values({ organizationId, seededAt: at })
    .onConflictDoNothing()
    .returning({ organizationId: sampleProjectSeeds.organizationId });
  return claimed.length === 1;
}

/** Record which project the claim produced. */
export async function recordSampleProject(
  organizationId: string,
  projectId: string,
  db: SampleSeedDb = getDb(),
): Promise<void> {
  await db
    .update(sampleProjectSeeds)
    .set({ projectId })
    .where(eq(sampleProjectSeeds.organizationId, organizationId));
}
