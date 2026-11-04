import assert from "node:assert/strict";
import { test } from "node:test";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { LOCAL_ORGANIZATION_ID } from "@/lib/adapters/oss/session";
import { events } from "@/lib/ingest/otlp/schema";
import { runtimeCatalogEntries } from "@/lib/ingest/runtime-catalog/schema";
import { traceEvents } from "@/lib/ingest/trace-events/schema";
import { jobs } from "@/lib/jobs/schema";
import type { getDb } from "@/lib/platform/db/client";
import * as schema from "@/lib/platform/db/tables";
import { createMigratedPGlite } from "@/lib/platform/db/test-support";
import { apiKeys, projects } from "@/lib/platform/projects/schema";
import { seedSiteCopilot } from "./site-copilot-seed";

// The open-source session port knows one organization, which the traces route reads for its quota.
const ORG = LOCAL_ORGANIZATION_ID;

test("the Site Copilot seed creates the sample project with its key, catalog, telemetry and ledger build", async () => {
  const client = await createMigratedPGlite();
  await client.exec(`insert into organizations (id, name, slug) values ('${ORG}', 'Acme', 'acme')`);
  const db = drizzle(client, { schema }) as unknown as ReturnType<typeof getDb>;

  const seeded = await seedSiteCopilot({ organizationId: ORG, turns: 12, seed: 7 }, db);

  const [project] = await db.select().from(projects).where(eq(projects.id, seeded.projectId));
  assert.equal(project?.isDemo, true, "the sample is marked as the demo project");
  assert.equal(project?.slug, "site-copilot");
  assert.equal(seeded.replaced, false);

  const n = async (
    table:
      | typeof events
      | typeof traceEvents
      | typeof apiKeys
      | typeof runtimeCatalogEntries
      | typeof jobs,
  ) => (await db.select({ n: count() }).from(table))[0]?.n ?? 0;
  assert.equal(await n(apiKeys), 1, "the seed's own key");
  assert.ok((await n(runtimeCatalogEntries)) > 0, "the catalog");
  assert.ok((await n(events)) > 0, "the spans landed as events");
  assert.ok((await n(traceEvents)) >= seeded.searchEvents, "the searches");
  assert.ok((await n(jobs)) >= 1, "the ledger build is queued, not run");

  const again = await seedSiteCopilot({ organizationId: ORG, turns: 12, seed: 7 }, db);
  assert.equal(again.projectId, seeded.projectId, "the same id on a rerun");
  assert.equal(again.replaced, true);
  await client.close();
});
