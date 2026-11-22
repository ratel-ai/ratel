import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * Lineage's table. Owned fragment of the upstream schema (ADR-0030): `lineage_links`, the
 * lineage partition of the upstream schema hub, column for column.
 */

/**
 * Lineage (RC-45): which object one step back each Monitor → Insights →
 * Improve → Ship object came from, for objects that have no row of their own
 * to carry it (an experiment is named by the SDK, a shipment has no table) or
 * whose source a person or an MCP call states explicitly. Read by
 * `lib/views/lineage/resolve.ts` before it derives a source from the data (an
 * insight's evidence turns, a fix's issues), so a recorded link wins.
 *
 * `kind`/`object_id` name the object as `LineageRef` does (`fix` +
 * `craft:<uuid>`, `experiment` + its name, `shipment` + its id); the
 * `source_*` columns are its source's `LineageRef`. Plain text, no foreign
 * keys: the objects live in different tables, or in none. One link per object.
 */
export const lineageLinks = pgTable(
  "lineage_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // "monitor" | "insights" | "improve" | "ship" (LINEAGE_STAGES).
    stage: text("stage").notNull(),
    kind: text("kind").notNull(),
    objectId: text("object_id").notNull(),
    sourceStage: text("source_stage").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    /** The source's label when it was recorded, for when it can no longer be read. */
    sourceLabel: text("source_label"),
    /** The identity provider's user id, `project:<id>` (an API key) or `system:<name>`. */
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("lineage_links_project_object_idx").on(t.projectId, t.kind, t.objectId),
    index("lineage_links_project_source_idx").on(t.projectId, t.sourceKind, t.sourceId),
    index("lineage_links_project_stage_idx").on(t.projectId, t.stage),
  ],
);

export type LineageLinkRow = typeof lineageLinks.$inferSelect;
export type NewLineageLinkRow = typeof lineageLinks.$inferInsert;
