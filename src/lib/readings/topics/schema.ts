import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { traceTurns } from "@/lib/ledger/schema";
import { projects } from "@/lib/platform/projects/schema";

/**
 * Topics: what people ask the agent about, grouped and named by the `assign_topics` job.
 * Owned fragment of the upstream schema (ADR-0030). The tables land before the job so the
 * self-corrections reading, which joins each turn's topic, has them to read.
 */

/**
 * One row per (project, topic id). Ids stay stable across runs: a later run keeps every
 * topic and only adds one when many asks fit none. Names and one-line descriptions only,
 * never member text.
 */
export const traceTopics = pgTable(
  "trace_topics",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    topicId: text("topic_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // "llm" | "words" (named from its own asks when no model key is set) | "user".
    labelSource: text("label_source").notNull().default("llm"),
    model: text("model"),
    // What the name was written from; a row is renamed only when this changes.
    inputHash: text("input_hash").notNull(),
    // Set when a topic stops getting asks for a whole window; kept for history.
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.topicId] })],
);

/**
 * Which topic each closed turn belongs to, written by `assign_topics`. Text free: the ask
 * is kept only as the hash workflow verdicts key on, and example text is read from the
 * turn's own captured events when a panel opens.
 */
export const traceTurnTopics = pgTable(
  "trace_turn_topics",
  {
    turnId: uuid("turn_id")
      .primaryKey()
      .references(() => traceTurns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Null unless `verdict` is "topic".
    topicId: text("topic_id"),
    // "topic" | "retry" (asks the last turn's question again) | "none" (fits no topic) | "no_ask" (no text to read).
    verdict: text("verdict").notNull(),
    // "user" | "prompt" | "search": where the ask was read from.
    askSource: text("ask_source"),
    askHash: text("ask_hash"),
    // "positive" | "neutral" | "negative"; null unless the user's own words were read.
    sentiment: text("sentiment"),
    // The turn's start, copied so a topic's turns page by time without a join.
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trace_turn_topics_project_topic_idx").on(t.projectId, t.topicId, t.startedAt)],
);

/**
 * Topic insights: the latest read of every topic's numbers (daily turns, answered,
 * sentiment, tasks, tools, example turn ids) and the flows (topics across a
 * conversation's turns). One row per project, replaced by each `assign_topics` job. Ids
 * and counts only.
 */
export const traceTopicInsights = pgTable("trace_topic_insights", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
  model: text("model"),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});
