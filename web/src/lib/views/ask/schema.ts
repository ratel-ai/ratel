import { index, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";
import type { AskOutcome, AskTarget, DraftedWidget, RefusedWidget } from "./domain";

/** What a draft gave, as the ask stores it. */
export interface StoredDraft {
  widgets: DraftedWidget[];
  refused: RefusedWidget[];
}

/**
 * Each ask of Ask in words: who asked, for what, in which words, the draft the model gave and
 * what the person did with it. The limits of `ask-limits` count these rows, and their `usd`
 * holds what the draft cost (its reservation until the calls are settled).
 */
export const askRequests = pgTable(
  "ask_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The person (their identity-provider id), or `project:<id>` for an API key.
    actor: text("actor").notNull(),
    // Where the ask came from: `console` or `mcp`.
    surface: text("surface").$type<"console" | "mcp">().notNull(),
    target: text("target").$type<AskTarget>().notNull(),
    // The dashboard of a widget ask. Null for a new dashboard.
    dashboardId: uuid("dashboard_id"),
    words: text("words").notNull(),
    // Null until the model answered.
    draft: jsonb("draft").$type<StoredDraft>(),
    model: text("model").notNull(),
    usd: numeric("usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    // Null until the person kept, edited or discarded the draft.
    outcome: text("outcome").$type<AskOutcome>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    outcomeAt: timestamp("outcome_at", { withTimezone: true }),
  },
  (t) => [
    index("ask_requests_project_created_idx").on(t.projectId, t.createdAt),
    index("ask_requests_actor_created_idx").on(t.actor, t.createdAt),
  ],
);

export type AskRequestRow = typeof askRequests.$inferSelect;
