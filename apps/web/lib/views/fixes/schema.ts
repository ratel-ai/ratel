import {
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/**
 * The Improve → Ship tables of a fix. Owned fragment of the upstream schema (ADR-0030):
 * `fix_experiments`, `fix_shipments` and `fix_shipment_tasks`, the fixes partition of the
 * upstream schema hub, column for column. A fix itself has no table (`lib/views/fixes`).
 */

/**
 * An experiment declared for one Fix (RC-43): the runtime tags the spans of
 * each arm with `ratel.experiment.id = name` and `ratel.experiment.arm`, and
 * the existing experiment reads (`otel_spans.experiment_name`) compare them.
 * `fix_id` is the Fix model's composite id (`issue:<id>`, `craft:<id>`, …),
 * computed by `lib/views/fixes`, so it is text rather than a foreign key; `insight_id`
 * is the Agent health signal the fix resolves, when it resolves one.
 */
export const fixExperiments = pgTable(
  "fix_experiments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fixId: text("fix_id").notNull(),
    insightId: uuid("insight_id"),
    // The `ratel.experiment.id` value the runtime sends.
    name: text("name").notNull(),
    baselineArm: text("baseline_arm").notNull().default("baseline"),
    candidateArm: text("candidate_arm").notNull().default("fix"),
    trafficPercent: integer("traffic_percent").notNull().default(50),
    // "running" | "stopped".
    status: text("status").notNull().default("running"),
    // Who created it: the identity provider's user id, or `project:<id>` for an API key.
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("fix_experiments_project_name_idx").on(t.projectId, t.name),
    index("fix_experiments_project_fix_idx").on(t.projectId, t.fixId),
  ],
);

/**
 * A Fix marked shipped (RC-43): which version of the customer's agent carries
 * it, linked back to the fix, the insight it resolves and, when it went through
 * one, the experiment. The Ship stage's record.
 */
export const fixShipments = pgTable(
  "fix_shipments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fixId: text("fix_id").notNull(),
    insightId: uuid("insight_id"),
    experimentId: uuid("experiment_id").references(() => fixExperiments.id, {
      onDelete: "set null",
    }),
    version: text("version").notNull(),
    notes: text("notes"),
    shippedBy: text("shipped_by").notNull(),
    liveMarkedBy: text("live_marked_by"),
    shippedAt: timestamp("shipped_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("fix_shipments_project_fix_idx").on(t.projectId, t.fixId),
    index("fix_shipments_project_shipped_idx").on(t.projectId, t.shippedAt),
  ],
);

/** The tasks a shipment is measured on after it ships; written by the task loop. */
export const fixShipmentTasks = pgTable(
  "fix_shipment_tasks",
  {
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => fixShipments.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.shipmentId, t.taskId] })],
);

export type FixExperimentRow = typeof fixExperiments.$inferSelect;
export type NewFixExperimentRow = typeof fixExperiments.$inferInsert;
export type FixShipmentRow = typeof fixShipments.$inferSelect;
export type NewFixShipmentRow = typeof fixShipments.$inferInsert;
