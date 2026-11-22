import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";
import type {
  DatasetCounts,
  DatasetFailure,
  DatasetSettings,
  DatasetStatus,
} from "@/lib/views/fine-tuning/domain/dataset";
import type { RedactionCounts } from "@/lib/views/fine-tuning/domain/redaction";
import type { DatasetSide, RowContent } from "@/lib/views/fine-tuning/domain/rows";
import type { UseCaseSelector } from "@/lib/views/fine-tuning/domain/use-case";

/**
 * The training opt-in of a project (fine-tuning, RC-1123, switch `FF_FINE_TUNING`): an
 * organization admin agrees that Ratel copies model call text into fine-tuning datasets.
 * One row per grant: a withdrawal stamps `withdrawn_by` and `withdrawn_at`,
 * and a later grant is a new row, so the history stays. At most one grant
 * per project is active (the partial unique index). `text_version` names the
 * consent copy the admin saw (`lib/console/onboarding/training-consent.ts`).
 */
export const fineTuningConsents = pgTable(
  "fine_tuning_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The identity-provider id of the admin who gave it.
    givenBy: text("given_by").notNull(),
    givenAt: timestamp("given_at", { withTimezone: true }).notNull().defaultNow(),
    textVersion: text("text_version").notNull(),
    // The identity-provider id of the admin who withdrew it.
    withdrawnBy: text("withdrawn_by"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("fine_tuning_consents_active_idx")
      .on(t.projectId)
      .where(sql`${t.withdrawnAt} IS NULL`),
    index("fine_tuning_consents_project_given_idx").on(t.projectId, t.givenAt),
  ],
);

export type FineTuningConsentRow = typeof fineTuningConsents.$inferSelect;

/**
 * Fine-tuning use cases (RC-1124): a named, project-scoped selector of model
 * calls (`lib/views/fine-tuning/domain/use-case.ts`): tasks or intents, a date
 * range and a call filter. A name is unique among the project's use cases
 * that are not archived. Archiving keeps the row.
 */
export const fineTuningUseCases = pgTable(
  "fine_tuning_use_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    selector: jsonb("selector").$type<UseCaseSelector>().notNull(),
    // The identity-provider id (or `project:<id>` for an API key) of who created it.
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("fine_tuning_use_cases_project_name_idx")
      .on(t.projectId, t.name)
      .where(sql`${t.archivedAt} IS NULL`),
    index("fine_tuning_use_cases_project_created_idx").on(t.projectId, t.createdAt),
  ],
);

export type FineTuningUseCaseRow = typeof fineTuningUseCases.$inferSelect;

/**
 * Fine-tuning dataset versions (RC-1128): one immutable build of a use case.
 * `version` counts up per use case. A build starts `building`, gets rows
 * appended page by page (`counts` holds its progress), and ends `ready` (with
 * `content_hash`) or `failed` (with `failed_reason`, and no rows).
 */
export const fineTuningDatasets = pgTable(
  "fine_tuning_datasets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    useCaseId: uuid("use_case_id")
      .notNull()
      .references(() => fineTuningUseCases.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").$type<DatasetStatus>().notNull().default("building"),
    settings: jsonb("settings").$type<DatasetSettings>().notNull(),
    contentHash: text("content_hash"),
    counts: jsonb("counts").$type<DatasetCounts>(),
    redactionReport: jsonb("redaction_report").$type<RedactionCounts>(),
    // The identity-provider id (or `project:<id>` for an API key) of who started it.
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    failedReason: text("failed_reason").$type<DatasetFailure>(),
  },
  (t) => [
    uniqueIndex("fine_tuning_datasets_use_case_version_idx").on(t.useCaseId, t.version),
    index("fine_tuning_datasets_project_idx").on(t.projectId, t.createdAt),
    check("fine_tuning_datasets_status_check", sql`${t.status} in ('building', 'ready', 'failed')`),
  ],
);

export type FineTuningDatasetRow = typeof fineTuningDatasets.$inferSelect;

/**
 * The rows of a dataset version (RC-1128): redacted model call content, its
 * side of the split and its source. Insert-only: a trigger refuses UPDATE
 * (core migration 0053).
 */
export const fineTuningDatasetRows = pgTable(
  "fine_tuning_dataset_rows",
  {
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => fineTuningDatasets.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    side: text("side").$type<DatasetSide>().notNull(),
    content: jsonb("content").$type<RowContent>().notNull(),
    rowHash: text("row_hash").notNull(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    turnId: uuid("turn_id").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.datasetId, t.ordinal] }),
    check("fine_tuning_dataset_rows_side_check", sql`${t.side} in ('train', 'eval')`),
  ],
);

export type FineTuningDatasetRowRow = typeof fineTuningDatasetRows.$inferSelect;
