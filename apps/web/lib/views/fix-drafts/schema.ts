import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * The drafted change of a fix. Owned fragment of the upstream schema (ADR-0030): `fix_drafts`,
 * the fix-drafts partition of the upstream schema hub, column for column. `fix_id` is the Fix
 * model's composite id (`issue:<id>`, `craft:<id>`, …), so it is text rather than a foreign key.
 * `spend` holds the reservation while a draft is `drafting`, then what the model call cost.
 */
export const fixDrafts = pgTable(
  "fix_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fixId: text("fix_id").notNull(),
    change: jsonb("change").notNull().default({}),
    origin: text("origin").notNull().default("drafted"),
    model: text("model"),
    spend: jsonb("spend"),
    status: text("status").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("fix_drafts_project_fix_created_idx").on(t.projectId, t.fixId, t.createdAt),
    uniqueIndex("fix_drafts_drafting_idx")
      .on(t.projectId, t.fixId)
      .where(sql`${t.status} = 'drafting'`),
    check("fix_drafts_origin_check", sql`${t.origin} in ('drafted', 'user')`),
    check(
      "fix_drafts_status_check",
      sql`${t.status} in ('drafting', 'ready', 'budget_refused', 'failed')`,
    ),
  ],
);

export type FixDraftRow = typeof fixDrafts.$inferSelect;
