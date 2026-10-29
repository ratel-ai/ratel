import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  type NewRuntimeCatalogEntry,
  runtimeCatalogEntries,
} from "@/lib/ingest/runtime-catalog/schema";
import { getDb } from "@/lib/platform/db/client";

export type RuntimeCatalogChannel = "events" | "snapshot";

export type RuntimeCatalogWriteDb = Pick<ReturnType<typeof getDb>, "insert">;

/**
 * A row renders 15 bind parameters, and Postgres counts them in an int16, so a
 * single statement tops out at 4369 rows. Both channels advertise more than
 * that — `MAX_CATALOG_TOOLS` and `MAX_LOG_RECORDS` are 5000 each — and an
 * over-limit statement is rejected by the driver, poisoning the caller's whole
 * ingest transaction and leaving its publisher to retry forever. Mirrors
 * `OTEL_LOG_INSERT_CHUNK_SIZE`.
 */
const RUNTIME_CATALOG_INSERT_CHUNK_SIZE = 500;

/** Upsert definitions from either runtime channel without regressing newer content. */
export async function upsertRuntimeCatalogEntries(
  entries: NewRuntimeCatalogEntry[],
  channel: RuntimeCatalogChannel,
  db: RuntimeCatalogWriteDb = getDb(),
): Promise<void> {
  // Chunked on the caller's `db`/`tx` handle, so a transaction still sees the
  // whole batch land or none of it.
  for (let offset = 0; offset < entries.length; offset += RUNTIME_CATALOG_INSERT_CHUNK_SIZE) {
    await upsertChunk(
      entries.slice(offset, offset + RUNTIME_CATALOG_INSERT_CHUNK_SIZE),
      channel,
      db,
    );
  }
}

async function upsertChunk(
  entries: NewRuntimeCatalogEntry[],
  channel: RuntimeCatalogChannel,
  db: RuntimeCatalogWriteDb,
): Promise<void> {
  await db
    .insert(runtimeCatalogEntries)
    .values(entries.map((entry) => ({ ...entry, provenance: channel })))
    .onConflictDoUpdate({
      target: [
        runtimeCatalogEntries.projectId,
        runtimeCatalogEntries.kind,
        runtimeCatalogEntries.entryId,
      ],
      set: {
        name: changedContent(runtimeCatalogEntries.name, "excluded.name"),
        description: changedContent(runtimeCatalogEntries.description, "excluded.description"),
        tags:
          channel === "events"
            ? changedContent(runtimeCatalogEntries.tags, "excluded.tags")
            : changedSnapshotDefault(runtimeCatalogEntries.tags, "excluded.tags"),
        inputSchema:
          channel === "events"
            ? changedContent(runtimeCatalogEntries.inputSchema, "excluded.input_schema")
            : changedSnapshotOptional(runtimeCatalogEntries.inputSchema, "excluded.input_schema"),
        outputSchema:
          channel === "events"
            ? changedContent(runtimeCatalogEntries.outputSchema, "excluded.output_schema")
            : changedSnapshotOptional(runtimeCatalogEntries.outputSchema, "excluded.output_schema"),
        searchableDescription:
          channel === "events"
            ? changedContent(
                runtimeCatalogEntries.searchableDescription,
                "excluded.searchable_description",
              )
            : changedSnapshotCustomised(
                runtimeCatalogEntries.searchableDescription,
                "excluded.searchable_description",
              ),
        searchableDescriptionOverridden:
          channel === "events"
            ? changedContent(
                runtimeCatalogEntries.searchableDescriptionOverridden,
                "excluded.searchable_description_overridden",
              )
            : changedSnapshotCustomised(
                runtimeCatalogEntries.searchableDescriptionOverridden,
                "excluded.searchable_description_overridden",
              ),
        ...(channel === "events"
          ? {
              useCloudDefinitions: sql`case when excluded.last_seen_at >= ${runtimeCatalogEntries.lastSeenAt} then excluded.use_cloud_definitions else ${runtimeCatalogEntries.useCloudDefinitions} end`,
            }
          : {}),
        provenance:
          channel === "events"
            ? sql`case when ${runtimeCatalogEntries.provenance} = 'snapshot' then 'both' else ${runtimeCatalogEntries.provenance} end`
            : sql`case when ${runtimeCatalogEntries.provenance} = 'events' then 'both' else ${runtimeCatalogEntries.provenance} end`,
        contentHash: changedContent(runtimeCatalogEntries.contentHash, "excluded.content_hash"),
        lastSeenAt: sql`greatest(${runtimeCatalogEntries.lastSeenAt}, excluded.last_seen_at)`,
      },
    });
}

function changedContent(column: AnyPgColumn, excluded: string) {
  return sql`case when excluded.content_hash <> ${runtimeCatalogEntries.contentHash} and excluded.last_seen_at >= ${runtimeCatalogEntries.lastSeenAt} then ${sql.raw(excluded)} else ${column} end`;
}

/**
 * Snapshots do not carry tags. Preserve the events-channel values once present,
 * while still refreshing snapshot-only defaults when a snapshot definition
 * changes. This field-preserving merge is preferable to channel hashes because
 * it needs no migration or backfill.
 */
function changedSnapshotDefault(column: AnyPgColumn, excluded: string) {
  return sql`case when ${runtimeCatalogEntries.provenance} = 'snapshot' then ${changedContent(column, excluded)} else ${column} end`;
}

/**
 * Retrieval-description state, for a channel that may or may not have supplied
 * it. A snapshot always writes a searchable description because the column is
 * NOT NULL, so "did the publisher mean it" cannot be read off the value: the
 * defaulted case is byte-identical to the description. `overridden` is that
 * signal. When it is set, the publisher stated its retrieval text deliberately
 * and outranks the events channel like any other definition field; when it is
 * not, this stays the events-preserving merge it has always been.
 */
function changedSnapshotCustomised(column: AnyPgColumn, excluded: string) {
  return sql`case when excluded.searchable_description_overridden then ${changedContent(column, excluded)} else ${changedSnapshotDefault(column, excluded)} end`;
}

/** Snapshot schemas are authoritative only when the snapshot carries them. */
function changedSnapshotOptional(column: AnyPgColumn, excluded: string) {
  return sql`case when ${sql.raw(excluded)} is not null then ${changedContent(column, excluded)} else ${column} end`;
}
