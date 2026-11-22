import { boolean, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * Agent overrides (RC-776): what a person corrected in the agents detection
 * found (`otel_spans.agent_key`, RC-772). One row per project and agent key:
 * a display name, hidden, or merged into another key. The Agents reads apply
 * them at read time, so stored spans never change and every override is
 * reversible. A merge is one hop (`./domain/overrides.ts`).
 *
 * Owned fragment of the upstream schema (ADR-0030): `agent_overrides`, the agents partition of
 * the upstream schema hub, column for column.
 */
export const agentOverrides = pgTable(
  "agent_overrides",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentKey: text("agent_key").notNull(),
    displayName: text("display_name"),
    hidden: boolean("hidden").notNull().default(false),
    mergedInto: text("merged_into"),
    // The identity-provider id of the person who last changed it.
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.agentKey] })],
);

export type AgentOverrideRow = typeof agentOverrides.$inferSelect;
