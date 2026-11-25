import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";
import type {
  AlertNoticeKind,
  AlertOperator,
  AlertState,
  AlertWindow,
} from "@/lib/views/alerts/types";

/** A project's alert rules, each with its current state. */
export const alertRules = pgTable(
  "alert_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    query: jsonb("query").$type<unknown>().notNull(),
    operator: text("operator").$type<AlertOperator>().notNull(),
    threshold: doublePrecision("threshold").notNull(),
    windowMinutes: integer("window_minutes").$type<AlertWindow>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    state: text("state").$type<AlertState>().notNull().default("no_data"),
    firing: boolean("firing").notNull().default(false),
    lastValue: doublePrecision("last_value"),
    stateChangedAt: timestamp("state_changed_at", { withTimezone: true }),
    // Null: due now.
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("alert_rules_project_idx").on(t.projectId, t.createdAt),
    index("alert_rules_enabled_idx").on(t.lastEvaluatedAt).where(sql`${t.enabled}`),
    check("alert_rules_operator_check", sql`${t.operator} in ('above', 'below')`),
    check("alert_rules_window_check", sql`${t.windowMinutes} in (5, 15, 60, 1440)`),
    check("alert_rules_state_check", sql`${t.state} in ('ok', 'alerting', 'no_data')`),
  ],
);

/** One row per state change, with the condition of that time. A row with a notice is also its outbox. */
export const alertEvents = pgTable(
  "alert_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => alertRules.id, { onDelete: "cascade" }),
    fromState: text("from_state").$type<AlertState>().notNull(),
    toState: text("to_state").$type<AlertState>().notNull(),
    value: doublePrecision("value"),
    operator: text("operator").$type<AlertOperator>().notNull(),
    threshold: doublePrecision("threshold").notNull(),
    windowMinutes: integer("window_minutes").$type<AlertWindow>().notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    // Null: the change tells nothing.
    notice: text("notice").$type<AlertNoticeKind>(),
    delivery: text("delivery").$type<"none" | "pending" | "sent" | "failed">().notNull(),
    attempts: integer("attempts").notNull().default(0),
    // Set while a tick sends; a claim that outlived its tick is taken again.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // The destinations that have the message, so a retry does not repeat it there.
    sentTo: jsonb("sent_to").$type<string[]>().notNull().default([]),
    error: text("error"),
  },
  (t) => [
    index("alert_events_rule_at_idx").on(t.ruleId, t.at),
    index("alert_events_pending_idx").on(t.at).where(sql`${t.delivery} = 'pending'`),
    check("alert_events_notice_check", sql`${t.notice} in ('fire', 'recovery')`),
    check(
      "alert_events_delivery_check",
      sql`${t.delivery} in ('none', 'pending', 'sent', 'failed')`,
    ),
  ],
);

export type AlertRuleRow = typeof alertRules.$inferSelect;
export type AlertEventRow = typeof alertEvents.$inferSelect;
