import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";
import type { RangePreset } from "@/lib/synthesis/dashboard";
import type { DashboardFilters } from "@/lib/views/dashboards/types";

/** A project's dashboards. The ordered widgets live with their dashboard: they are read together. */
export const dashboards = pgTable(
  "dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    widgets: jsonb("widgets").$type<unknown[]>().notNull().default([]),
    // What the dashboard opens with, unless its address says otherwise.
    filters: jsonb("filters").$type<DashboardFilters>().notNull().default({}),
    // A range preset. Null: the console's default.
    range: text("range").$type<RangePreset>(),
    // The identity-provider id of the person who last changed it.
    updatedBy: text("updated_by").notNull(),
    // How that person was shown then. The core has no table of people.
    updatedByName: text("updated_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dashboards_project_created_idx").on(t.projectId, t.createdAt)],
);
