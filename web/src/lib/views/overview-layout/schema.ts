import { integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * How one person arranged the Overview of one project. No row: the default layout. `person_id` is
 * the session port's external id (`SessionUser.externalId`), which is also an OAuth MCP caller's
 * `externalUserId`; in the open-source edition it is the one operator.
 */
export const overviewLayouts = pgTable(
  "overview_layouts",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    personId: text("person_id").notNull(),
    /** `StoredOverviewLayout`, read only through `readArrangement`. */
    layout: jsonb("layout").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.personId] })],
);

/**
 * The last changes of one person's layout (`LayoutChangeEntry`). `person_id` is the author too:
 * nobody else can change the layout. `layout` and `before` are read only through `readArrangement`.
 */
export const overviewLayoutChanges = pgTable(
  "overview_layout_changes",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    personId: text("person_id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").$type<"change" | "undo" | "restore">().notNull(),
    source: text("source").$type<"web" | "mcp">().notNull(),
    /** The MCP client's name, as it gave it. */
    client: text("client"),
    summary: text("summary").notNull(),
    undoes: integer("undoes"),
    /** The stored layout before the change; null when there was none. */
    before: jsonb("before"),
    layout: jsonb("layout").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.personId, t.seq] })],
);
