import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The last failure of each feature's model calls (ADR-0009 §13), for the console's Models settings:
 * one row per feature, rewritten on each failure. Its sentence names settings, a vendor, a model
 * and a status code, never a key or a provider's own words (`explain.ts`). Deployment-wide: the
 * models are the deployment's, not a project's.
 */
export const modelFailures = pgTable("model_failures", {
  feature: text("feature").primaryKey(),
  /** text or decision. */
  kind: text("kind").notNull(),
  /** The spend line's provider. */
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  /** What went wrong and the setting to fix, as `explainModelError` wrote it. */
  message: text("message").notNull(),
  status: integer("status"),
  /** Failures since the last call that worked. */
  failures: integer("failures").notNull().default(1),
  failedAt: timestamp("failed_at", { withTimezone: true }).notNull().defaultNow(),
  /** The last call that worked after it, if one did. */
  okAt: timestamp("ok_at", { withTimezone: true }),
});

export type ModelFailureRow = typeof modelFailures.$inferSelect;
