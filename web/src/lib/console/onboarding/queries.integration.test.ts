import assert from "node:assert/strict";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/pglite";
import type { getDb } from "@/lib/platform/db/client";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { claimSampleProjectSeeding, recordSampleProject } from "./queries";
import { sampleProjectSeeds } from "./schema";

const ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "11111111-1111-4111-8111-111111111111";

test("the sample seed is claimed once per organization, and the project recorded on it", async () => {
  const client = await createMigratedPGlite();
  const db = drizzle(client, { schema: { sampleProjectSeeds } }) as unknown as ReturnType<
    typeof getDb
  >;
  const at = new Date("2026-11-04T10:00:00Z");

  assert.equal(await claimSampleProjectSeeding(ORG, at, db), true);
  assert.equal(await claimSampleProjectSeeding(ORG, new Date(), db), false, "a second claim loses");

  await recordSampleProject(ORG, PROJECT, db);
  const [row] = await db.select().from(sampleProjectSeeds);
  assert.deepEqual(row, { organizationId: ORG, seededAt: at, projectId: PROJECT });
  await client.close();
});
