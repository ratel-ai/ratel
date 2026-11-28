import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";
import { dashboards } from "@/lib/views/dashboards/schema";

/**
 * Each dashboard a template made for a project (decision `dashboard-templates`): a default given
 * one time (`given = 'default'`), or a template a person or an agent picked (`picked`). A default's
 * row stays when its dashboard is deleted, so the default does not come back. The unique key makes
 * two first reads at the same time give a project each default once. A pick is a kept signal of
 * Ask in words: the next suggestions read it.
 */
export const dashboardTemplateUses = pgTable(
  "dashboard_template_uses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The id of the template in code (`templates/index.ts`).
    templateId: text("template_id").notNull(),
    // The dashboard it made. Null once that dashboard is deleted.
    dashboardId: uuid("dashboard_id").references(() => dashboards.id, { onDelete: "set null" }),
    given: text("given").$type<"default" | "picked">().notNull(),
    // Who made it: `system` for a default, else the person or `project:<id>` for an API key.
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("dashboard_template_uses_default_key")
      .on(t.projectId, t.templateId)
      .where(sql`${t.given} = 'default'`),
    index("dashboard_template_uses_project_created_idx").on(t.projectId, t.createdAt),
  ],
);
