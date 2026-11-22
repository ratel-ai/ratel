import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * A project's own span attribute read as a variant (RC-869, switch `FF_VARIANT_EXPERIMENTS`): a
 * span carrying `attribute_key` and no `ratel.variant.name` is stored as the variant named by that
 * attribute's value, in `experiment`. One mapping per key.
 */
export const variantAttributeMappings = pgTable(
  "variant_attribute_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    attributeKey: text("attribute_key").notNull(),
    experiment: text("experiment").notNull(),
    // The identity-provider id of the member who saved it.
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("variant_attribute_mappings_project_key_idx").on(t.projectId, t.attributeKey),
  ],
);

export type VariantAttributeMapping = typeof variantAttributeMappings.$inferSelect;
