import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/** Which SDK runtimes report events for a project. Owned fragment of the upstream schema (ADR-0030). */

/** Stable runtime publisher identities and the receipt/event-time facts boundary. */
export const runtimeEventSources = pgTable(
  "runtime_event_sources",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    // Null for a source known only from catalog snapshots. A snapshot must not
    // start the direct-facts era or suppress OTLP reconstruction.
    factsStartedAt: timestamp("facts_started_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.sourceId] }),
    index("runtime_event_sources_project_last_seen_idx").on(t.projectId, t.lastSeenAt),
  ],
);

export type RuntimeEventSource = typeof runtimeEventSources.$inferSelect;
export type NewRuntimeEventSource = typeof runtimeEventSources.$inferInsert;
