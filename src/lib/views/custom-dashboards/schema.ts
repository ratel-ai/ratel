import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * Custom dashboards (RC-887): a project's dashboards of
 * whitelisted widgets over `otel_trace_summaries` (`./`). `sharing`: `private` opens for its
 * creator only, `project` for every project member by link.
 */
export const dashboards = pgTable(
  "dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // The identity-provider id of the member who created it.
    createdBy: text("created_by").notNull(),
    sharing: text("sharing").$type<"private" | "project">().notNull().default("private"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("dashboards_project_created_idx").on(t.projectId, t.createdAt),
    check("dashboards_sharing_check", sql`${t.sharing} in ('private', 'project')`),
  ],
);

export type DashboardRow = typeof dashboards.$inferSelect;

/** One widget of a dashboard: a validated widget spec (`./spec.ts`), drawn in `position` order. */
export const dashboardWidgets = pgTable(
  "dashboard_widgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dashboardId: uuid("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    spec: jsonb("spec").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dashboard_widgets_dashboard_position_idx").on(t.dashboardId, t.position)],
);

export type DashboardWidgetRow = typeof dashboardWidgets.$inferSelect;
