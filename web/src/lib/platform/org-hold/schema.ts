import { sql } from "drizzle-orm";
import { check, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * An organization, or single projects, whose data is in this deployment but not yet in use: no
 * job runs and the console is closed until the hold is cleared (`docs/internal-api.md`). Empty
 * unless the internal route sets one. The edition owns the organizations table, so there is no
 * foreign key to it.
 */
export const orgHolds = pgTable(
  "org_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    since: timestamp("since", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("org_holds_organization_idx")
      .on(t.organizationId)
      .where(sql`${t.organizationId} is not null`),
    uniqueIndex("org_holds_project_idx").on(t.projectId).where(sql`${t.projectId} is not null`),
    check("org_holds_one_scope", sql`num_nonnulls(${t.organizationId}, ${t.projectId}) = 1`),
  ],
);
