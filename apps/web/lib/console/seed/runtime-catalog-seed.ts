import { demoRuntimeCatalogEntries } from "@/lib/console/seed/demo-runtime-catalog";
import {
  type RuntimeCatalogWriteDb,
  upsertRuntimeCatalogEntries,
} from "@/lib/ingest/runtime-catalog/queries";
import { getDb } from "@/lib/platform/db/client";

/**
 * Register a seeded tool catalog as RUNTIME CATALOG entries.
 *
 * Seeding `tool_definitions` alone produces a project where no tool is
 * Ratel-managed: every entry reports `entryId === null`, so the searchable
 * description cannot be edited or saved anywhere, and the product's central
 * catalog behavior is simply absent from the demo. Both seeders got this wrong
 * in the same way, which is why the registration lives here rather than being
 * written out twice.
 *
 * The rows themselves come from `demo-runtime-catalog`, which also supplies the
 * runtime-only tools that give the catalog enough entries to page through.
 *
 * The channel is `events`, not `snapshot`. A snapshot cannot carry
 * `use_cloud_definitions` at all — `catalogs/queries.ts` writes it `false`
 * unconditionally — and the whole point of these rows is to show a runtime that
 * has adopted a Cloud override alongside one that has not. A registered catalog
 * arriving over the events channel is exactly what a runtime with the SDK
 * attached produces, so nothing here is pretending to be telemetry.
 */
export async function seedRuntimeToolCatalog(
  projectId: string,
  now: Date,
  db: RuntimeCatalogWriteDb = getDb(),
): Promise<void> {
  await upsertRuntimeCatalogEntries(demoRuntimeCatalogEntries(projectId, now), "events", db);
}
