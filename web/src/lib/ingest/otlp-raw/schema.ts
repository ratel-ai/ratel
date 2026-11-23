import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/** Raw OTLP request bodies. Owned fragment of the upstream schema (ADR-0004). */

/** Postgres `bytea`, read and written as bytes. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

/**
 * Raw OTLP request bodies (lib/ingest/otlp-raw), gzipped, one row per accepted export.
 * Kept within a per-project daily byte cap and pruned on `received_at`.
 */
export const otlpRawExports = pgTable(
  "otlp_raw_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    signal: text("signal").$type<"traces" | "logs">().notNull(),
    contentType: text("content_type").notNull(),
    body: bytea("body").notNull(),
    rawBytes: integer("raw_bytes").notNull(),
    storedBytes: integer("stored_bytes").notNull(),
    itemCount: integer("item_count").notNull(),
    traceIds: text("trace_ids").array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    index("otlp_raw_exports_project_received_idx").on(t.projectId, t.receivedAt),
    index("otlp_raw_exports_received_at_idx").on(t.receivedAt, t.id),
    index("otlp_raw_exports_trace_ids_idx").using("gin", t.traceIds),
    check("otlp_raw_exports_signal_check", sql`${t.signal} in ('traces', 'logs')`),
  ],
);

export type OtlpRawExport = typeof otlpRawExports.$inferSelect;
