import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * The attributes a project slices its traces by (RC-881, switch `FF_PIVOTS`), at most 5
 * (`./model.ts`). A preset pivot (`presetId` set) reads its preset's ordered keys and stores the
 * preset id as `key`. A custom pivot reads the one attribute key in `key`. `position` orders them
 * on every surface.
 */
export const projectPivots = pgTable(
  "project_pivots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    presetId: text("preset_id"),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("project_pivots_project_key_idx").on(t.projectId, t.key)],
);

export type ProjectPivotRow = typeof projectPivots.$inferSelect;
