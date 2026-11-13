import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { MAX_CATALOG_TOOLS } from "@/lib/ingest/catalogs/snapshot";
import {
  type RuntimeCatalogWriteDb,
  upsertRuntimeCatalogEntries,
} from "@/lib/ingest/runtime-catalog/queries";
import type { NewRuntimeCatalogEntry } from "@/lib/ingest/runtime-catalog/schema";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

// An MCP aggregator publishing at the advertised cap is the whole point of the
// cap. One statement per row-batch renders 15 bind parameters a row, and
// Postgres' Bind message counts them in an int16 — 5_000 rows overflows 65_535
// and the driver rejects the statement, poisoning the whole ingest transaction.
// The publisher then retries forever with backoff and never converges.
test("a snapshot at the advertised tool cap lands in full", async () => {
  const { client, db } = await setup();

  await upsertRuntimeCatalogEntries(entries(MAX_CATALOG_TOOLS, "v1"), "snapshot", db);

  assert.deepEqual(await summary(client), {
    total: MAX_CATALOG_TOOLS,
    descriptions: 1,
    sample: "tool 0000 v1",
  });
  await client.close();
});

test("re-upserting at the cap updates every row through the conflict branch", async () => {
  const { client, db } = await setup();
  await upsertRuntimeCatalogEntries(entries(MAX_CATALOG_TOOLS, "v1"), "snapshot", db);

  await upsertRuntimeCatalogEntries(entries(MAX_CATALOG_TOOLS, "v2"), "snapshot", db);

  assert.deepEqual(await summary(client), {
    total: MAX_CATALOG_TOOLS,
    descriptions: 1,
    sample: "tool 0000 v2",
  });
  await client.close();
});

function entries(count: number, revision: string): NewRuntimeCatalogEntry[] {
  const seenAt = new Date(`2026-08-18T12:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const entryId = `tool ${String(index).padStart(4, "0")}`;
    return {
      projectId: PROJECT_ID,
      kind: "tool",
      entryId,
      name: entryId,
      description: `${entryId} ${revision}`,
      tags: [],
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
      searchableDescription: `${entryId} ${revision}`,
      searchableDescriptionOverridden: false,
      useCloudDefinitions: false,
      contentHash: `${revision}-${index}`,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    };
  });
}

async function summary(
  client: PGlite,
): Promise<{ total: number; descriptions: number; sample: string }> {
  const { rows } = await client.query<{
    total: number;
    descriptions: number;
    sample: string;
  }>(`
    select
      count(*)::int as total,
      count(distinct right(description, 2))::int as descriptions,
      min(description) as sample
    from runtime_catalog_entries
    where project_id = '${PROJECT_ID}'
  `);
  return rows[0];
}

async function setup(): Promise<{ client: PGlite; db: RuntimeCatalogWriteDb }> {
  const client = await createMigratedPGlite();
  await client.exec(`
    insert into organizations (id, name, slug)
    values ('${ORGANIZATION_ID}', 'Acme', 'acme');
    insert into projects (id, organization_id, name, slug)
    values ('${PROJECT_ID}', '${ORGANIZATION_ID}', 'Agent', 'agent');
  `);
  return { client, db: drizzle(client, { schema }) as unknown as RuntimeCatalogWriteDb };
}
