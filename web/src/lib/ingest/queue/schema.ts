import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/** Postgres `bytea`, read and written as bytes. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

/**
 * Accepted ingest batches waiting to be persisted (RTL-314, ADR-0009). The request stores the
 * body as it arrived (with its `Content-Encoding`) and answers 202; a worker claims the row, decodes
 * it and writes through the same path the inline route uses. `queued` → `running` → `done`, or back
 * to `queued` after a failed try (`available_at` is the backoff) until `failed`. A done row drops
 * its body; done rows go after an hour and failed ones after a week (`pruneIngestBatches`).
 */
export const ingestBatches = pgTable(
  "ingest_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    signal: text("signal").$type<IngestBatchSignal>().notNull(),
    contentType: text("content_type").notNull(),
    contentEncoding: text("content_encoding"),
    body: bytea("body").notNull(),
    bodyBytes: integer("body_bytes").notNull(),
    /** What the request knew that the worker needs: the key's policy (`IngestBatchContext`). */
    context: jsonb("context").$type<IngestBatchContext>().notNull().default(sql`'{}'::jsonb`),
    status: text("status").$type<IngestBatchStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    result: jsonb("result"),
  },
  (t) => [
    // The claim and the depth read: a project's queued batches, oldest first.
    index("ingest_batches_queued_idx")
      .on(t.projectId, t.receivedAt)
      .where(sql`${t.status} = 'queued'`),
    // The per-project cap and the reaper.
    index("ingest_batches_running_idx")
      .on(t.projectId, t.startedAt)
      .where(sql`${t.status} = 'running'`),
    // Retention and the recent-failures read.
    index("ingest_batches_finished_idx")
      .on(t.status, t.finishedAt)
      .where(sql`${t.status} in ('done', 'failed')`),
    check("ingest_batches_signal_check", sql`${t.signal} in ('traces', 'logs', 'events')`),
    check(
      "ingest_batches_status_check",
      sql`${t.status} in ('queued', 'running', 'done', 'failed')`,
    ),
  ],
);

export type IngestBatchSignal = "traces" | "logs" | "events";
export type IngestBatchStatus = "queued" | "running" | "done" | "failed";

/** The request's knowledge a worker needs to persist the batch as the request would have. */
export interface IngestBatchContext {
  /** The key only adds rows (RC-590, `ApiKeyPolicy.appendOnlyIngest`). */
  appendOnly?: boolean;
  /** Set when the request located the batch: the body holds the codes, and not what gave them. */
  geo?: { addressed: boolean };
}
