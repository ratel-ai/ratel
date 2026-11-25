import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  index,
  integer,
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
 * The ingest queue of a deployment with only Postgres (ADR-0009): one row per accepted request
 * that waits to be processed, and the dead letters. Apart from `jobs`, which coalesces the work
 * of a project: here every row counts and keeps its place.
 */
export const ingestSpool = pgTable(
  "ingest_spool",
  {
    /** The order of the queue. */
    seq: bigint("seq", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** The envelope's id. Not unique: a dead letter can be published again. */
    messageId: uuid("message_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The envelope, encoded. */
    frame: bytea("frame").notNull(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    /** Deliveries that count: raised by the claim, given back after an outage. */
    deliveries: integer("deliveries").notNull().default(0),
    /** Outages in a row, for the wait. */
    outages: integer("outages").notNull().default(0),
    /** Not delivered before this time: the wait after a failure. */
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    /** Who has the message in hand, and until when the claim holds without a renewal. */
    claimToken: uuid("claim_token"),
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
    /** Why the last delivery failed. Never telemetry content. */
    reason: text("reason"),
    firstFailedAt: timestamp("first_failed_at", { withTimezone: true }),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
    /** Set on a dead letter, which nothing delivers again. */
    deadAt: timestamp("dead_at", { withTimezone: true }),
  },
  (t) => [
    index("ingest_spool_queued_idx").on(t.projectId, t.seq).where(sql`${t.deadAt} is null`),
    index("ingest_spool_claimed_idx").on(t.projectId).where(sql`${t.claimedUntil} is not null`),
    index("ingest_spool_dead_idx").on(t.deadAt, t.seq).where(sql`${t.deadAt} is not null`),
    // The delete of a project reads its rows, dead letters included.
    index("ingest_spool_dead_project_idx")
      .on(t.projectId, t.deadAt)
      .where(sql`${t.deadAt} is not null`),
  ],
);
