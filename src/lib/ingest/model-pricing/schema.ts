import { numeric, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { projects } from "@/lib/platform/projects/schema";

/** Per-project model prices. Owned fragment of the upstream schema (ADR-0030). */

/**
 * A project's own token prices (RC-482), in USD per 1M tokens. They win over the
 * built-in `MODEL_PRICES` (lib/ingest/pricing.ts) for every cost of the project's own
 * model calls: ingest, the re-price of stored rows and the read-side totals.
 * Ratel's own vendor prices never read this table. Null `cached_input` and
 * `cache_write` bill those tokens at `input`, as the built-in table does.
 */
export const projectModelPrices = pgTable(
  "project_model_prices",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    input: numeric("input_usd_per_mtok", { precision: 12, scale: 6 }).notNull(),
    output: numeric("output_usd_per_mtok", { precision: 12, scale: 6 }).notNull(),
    cachedInput: numeric("cached_input_usd_per_mtok", { precision: 12, scale: 6 }),
    cacheWrite: numeric("cache_write_usd_per_mtok", { precision: 12, scale: 6 }),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.model] })],
);

export type ProjectModelPriceRow = typeof projectModelPrices.$inferSelect;
