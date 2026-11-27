import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/** The attribute names a project reads a trace's location from. No row: the defaults. */
export const projectGeoAttributes = pgTable("project_geo_attributes", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  address: text("address").notNull(),
  country: text("country").notNull(),
  region: text("region").notNull(),
  latitude: text("latitude").notNull(),
  longitude: text("longitude").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
