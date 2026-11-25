import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";
import type { CaseContent, CaseScorer, EarlierTurn } from "./domain/case";

/** The tables of evals (the `evals` flag). */

/** A case: its name and its labels. What it checks is in its versions. */
export const evalCases = pgTable(
  "eval_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Plain text. A label for a task or an intent refers to no row.
    labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
    // The identity provider's user id.
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("eval_cases_project_created_idx").on(t.projectId, t.createdAt)],
);

/** A version of a case. Only a draft changes: an approved version is frozen. */
export const evalCaseVersions = pgTable(
  "eval_case_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => evalCases.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    // "draft" | "approved"
    state: text("state").notNull().default("draft"),
    input: jsonb("input").$type<unknown>(),
    earlierTurns: jsonb("earlier_turns").$type<EarlierTurn[]>().notNull(),
    toolFixtures: jsonb("tool_fixtures").$type<CaseContent["toolFixtures"]>().notNull(),
    expectedOutput: text("expected_output"),
    scorers: jsonb("scorers").$type<CaseScorer[]>().notNull(),
    // No foreign key: a pruned turn must not change a version.
    sourceTurnId: uuid("source_turn_id"),
    // The recorded answer of that turn, for the editor. No scorer reads it.
    sourceOutput: text("source_output"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("eval_case_versions_case_number_idx").on(t.caseId, t.number),
    uniqueIndex("eval_case_versions_one_draft_idx").on(t.caseId).where(sql`${t.state} = 'draft'`),
  ],
);
