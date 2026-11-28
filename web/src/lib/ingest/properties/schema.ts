import { sql } from "drizzle-orm";
import { bigint, check, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";
import type { PropertySource } from "./keys";

/** `detected`: ingest saw the key name. `indexed`: Ratel stores its values on each trace. */
export type PropertyState = "detected" | "indexed";

/**
 * The trace property keys of each project (RTL-395, `lib/ingest/properties`): key names only, never
 * a value. Ingest adds a row the first time it sees a key, at most `MAX_DETECTED_KEYS` keys of the
 * user's own per project; a standard property starts `indexed`, any other key `detected`.
 */
export const tracePropertyKeys = pgTable(
  "trace_property_keys",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The canonical name of a standard property, else the attribute key as sent.
    name: text("name").notNull(),
    state: text("state").$type<PropertyState>().notNull(),
    source: text("source").$type<PropertySource>().notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    // Approximate: ingest counts a key again only after its in-process cache lets it through.
    seenCount: bigint("seen_count", { mode: "number" }).notNull().default(0),
    // When the values started to be stored. Kept when the property stops, so a stopped property
    // whose values are still stored shows it; null once they are erased, and for a key that was
    // never indexed.
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.name] }),
    check("trace_property_keys_state_check", sql`${t.state} in ('detected', 'indexed')`),
    check("trace_property_keys_source_check", sql`${t.source} in ('standard', 'user')`),
  ],
);
