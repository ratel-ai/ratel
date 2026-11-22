import { pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Which organizations have had their sample project, once. Upstream keeps this mark as a column
 * of the organizations table; identity is the edition's here (ADR-0030), so the core keeps it in
 * a table of its own, keyed on the organization id with no foreign key.
 *
 * The mark is on the organization, not on the project: deleting the sample must not bring it
 * back. It is claimed before the seed runs, so a seed that fails stays failed rather than
 * re-running on every visit.
 */
export const sampleProjectSeeds = pgTable("sample_project_seeds", {
  organizationId: uuid("organization_id").primaryKey(),
  seededAt: timestamp("seeded_at", { withTimezone: true }).notNull().defaultNow(),
  // The project the seed created, for the record; null while the seed runs or after it failed.
  projectId: uuid("project_id"),
});

export type SampleProjectSeed = typeof sampleProjectSeeds.$inferSelect;
