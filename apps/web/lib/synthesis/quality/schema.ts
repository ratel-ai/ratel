import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * Append-only record of what a project's retrieval actually matched on.
 *
 * The fingerprint hashes the resolved searchable text — overrides included —
 * rather than the catalog receipt, because that is the corpus retrieval reads.
 * `catalog_snapshots.content_hash` cannot serve here: it is keyed per source and
 * overwritten on every sync, it covers agent descriptions and schemas we do not
 * match on, and it is blind to a Cloud-side override that changes ranking
 * without the publisher sending anything.
 *
 * One row per distinct corpus a project has had. A re-sync that changes nothing
 * we match on only bumps `last_seen_at`, so the row count is the number of times
 * retrieval could actually have behaved differently — which is what the quality
 * trend marks its change lines against.
 */
export const catalogFingerprints = pgTable(
  "catalog_fingerprints",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    entryCount: integer("entry_count").notNull(),
    /** Total characters of resolved searchable text: the corpus's raw size. */
    searchableChars: integer("searchable_chars").notNull(),
    /** Entries carrying a Cloud-side operator override. */
    overriddenCount: integer("overridden_count").notNull(),
    /** Entries whose searchable text differs from the agent description. */
    distinctCount: integer("distinct_count").notNull(),
    /** The canonical triples, so a past corpus stays readable after a re-sync. */
    entries: jsonb("entries").$type<CatalogFingerprintEntry[]>().notNull().default([]),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.fingerprint] }),
    index("catalog_fingerprints_project_last_seen_idx").on(t.projectId, t.lastSeenAt),
  ],
);

/** One capability as retrieval sees it: its id, its name, its searchable text. */
export interface CatalogFingerprintEntry {
  kind: string;
  entryId: string;
  name: string;
  searchable: string;
}

/**
 * Daily rollup of the search-quality meter, one row per arm and evidence tier.
 *
 * A derived table rather than a live query for one reason: `otel_logs` is pruned
 * at 30 days, so without this the quality trend can never be longer than a
 * month, and the whole point is to see whether a searchable-description edit
 * three months ago helped.
 *
 * SUMS, not rates. Re-deriving a rate from `credit_sum / n` weights every search
 * equally across a multi-day window; averaging stored daily rates would weight a
 * quiet Sunday like a busy Tuesday. `lib/quality/metrics.ts` folds these.
 */
export const qualitySnapshots = pgTable(
  "quality_snapshots",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The calibration, i.e. `otel_logs.experiment_name`. */
    experimentName: text("experiment_name").notNull(),
    arm: text("arm").notNull(),
    /** `revealed` (the tool the agent ran) or `reference` (the baseline's top result). */
    tier: text("tier").notNull(),
    /** UTC day the searches occurred on. */
    day: timestamp("day", { withTimezone: true }).notNull(),
    /** Evaluable searches. Every rate derived from this row needs it. */
    n: integer("n").notNull(),
    contained: integer("contained").notNull(),
    creditSum: doublePrecision("credit_sum").notNull(),
    reciprocalSum: doublePrecision("reciprocal_sum").notNull(),
    rankHistogram: jsonb("rank_histogram").$type<Record<string, number>>().notNull().default({}),
    /** The corpus live for this day, when one fingerprint covered all of it. */
    fingerprint: text("fingerprint"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.projectId, t.experimentName, t.arm, t.tier, t.day],
    }),
    index("quality_snapshots_project_day_idx").on(t.projectId, t.day),
  ],
);

/* — Match quality ----------------------------------------------------------- */

export type CatalogFingerprintRow = typeof catalogFingerprints.$inferSelect;
export type NewCatalogFingerprint = typeof catalogFingerprints.$inferInsert;
export type QualitySnapshotRow = typeof qualitySnapshots.$inferSelect;
export type NewQualitySnapshot = typeof qualitySnapshots.$inferInsert;
