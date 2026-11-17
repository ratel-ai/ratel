import { and, asc, desc, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import { projectModelPrices } from "@/lib/ingest/model-pricing/schema";
import { events, otelSpans } from "@/lib/ingest/otlp/schema";
import type { ModelPrice, PriceOverrides } from "@/lib/ingest/pricing";
import type { getDb } from "@/lib/platform/db/client";

/**
 * A project's own model prices (RC-482) and the models its traces used. The
 * prices win over the built-in table everywhere a cost of the project's own
 * model calls is computed. Rates are USD per 1M tokens.
 */

export type ModelPricingDb = Pick<ReturnType<typeof getDb>, "select" | "insert" | "delete">;

/** The rates a person sets for one model. No long-context tiers: one rate for every call. */
export type ModelPriceInput = Pick<ModelPrice, "input" | "output" | "cachedInput" | "cacheWrite">;

/** A model the project's calls used, with how many calls and how many of them have no cost. */
export interface SeenModel {
  model: string;
  calls: number;
  unpricedCalls: number;
}

/** How far back "seen" reaches: the model calls a person still looks at. */
export const SEEN_WINDOW_DAYS = 30;
/** The most models the list shows; a project rarely uses more than a handful. */
export const MAX_SEEN_MODELS = 200;

/** The project's own prices, keyed by model id, ready for `costFor`. */
export async function loadPriceOverrides(
  projectId: string,
  db: Pick<ModelPricingDb, "select">,
): Promise<PriceOverrides> {
  const rows = await db
    .select({
      model: projectModelPrices.model,
      input: projectModelPrices.input,
      output: projectModelPrices.output,
      cachedInput: projectModelPrices.cachedInput,
      cacheWrite: projectModelPrices.cacheWrite,
    })
    .from(projectModelPrices)
    .where(eq(projectModelPrices.projectId, projectId));
  const overrides: Record<string, ModelPrice> = {};
  for (const row of rows) {
    overrides[row.model] = {
      input: Number(row.input),
      output: Number(row.output),
      ...(row.cachedInput !== null ? { cachedInput: Number(row.cachedInput) } : {}),
      ...(row.cacheWrite !== null ? { cacheWrite: Number(row.cacheWrite) } : {}),
    };
  }
  return overrides;
}

/**
 * Set the project's price of one model, replacing any earlier one. Returns
 * the saved row's `updated_at`: the version a re-price of this save checks,
 * so an older save's re-price never overwrites a newer one.
 */
export async function saveModelPrice(
  projectId: string,
  model: string,
  price: ModelPriceInput,
  updatedBy: string,
  db: Pick<ModelPricingDb, "insert">,
): Promise<Date> {
  const values = {
    input: String(price.input),
    output: String(price.output),
    cachedInput: price.cachedInput === undefined ? null : String(price.cachedInput),
    cacheWrite: price.cacheWrite === undefined ? null : String(price.cacheWrite),
    updatedBy,
    updatedAt: new Date(),
  };
  await db
    .insert(projectModelPrices)
    .values({ projectId, model, ...values })
    .onConflictDoUpdate({
      target: [projectModelPrices.projectId, projectModelPrices.model],
      set: values,
    });
  return values.updatedAt;
}

/** Drop the project's price of one model, so the built-in price (or none) applies again. */
export async function deleteModelPrice(
  projectId: string,
  model: string,
  db: Pick<ModelPricingDb, "delete">,
): Promise<boolean> {
  const deleted = await db
    .delete(projectModelPrices)
    .where(and(eq(projectModelPrices.projectId, projectId), eq(projectModelPrices.model, model)))
    .returning({ model: projectModelPrices.model });
  return deleted.length > 0;
}

/**
 * The models the project's model calls used in the last {@link SEEN_WINDOW_DAYS}
 * days, busiest first. Spans are the source; a model only in `events` (the SDK
 * lane, which sends no spans) is added from there. An OTLP call is in both
 * tables, so a model the spans know keeps the span counts and is not counted twice.
 */
export async function listSeenModels(
  projectId: string,
  db: Pick<ModelPricingDb, "select">,
  { now = new Date() }: { now?: Date } = {},
): Promise<SeenModel[]> {
  const since = new Date(now.getTime() - SEEN_WINDOW_DAYS * 86_400_000);
  const calls = sql<number>`count(*)::int`;
  const unpriced = (cost: typeof otelSpans.costUsd | typeof events.costUsd) =>
    sql<number>`(count(*) filter (where ${cost} is null))::int`;

  const spanRows = await db
    .select({
      model: sql<string>`${otelSpans.model}`,
      calls,
      unpricedCalls: unpriced(otelSpans.costUsd),
    })
    .from(otelSpans)
    .where(
      and(
        eq(otelSpans.projectId, projectId),
        gte(otelSpans.startedAt, since),
        isNotNull(otelSpans.model),
        or(isNotNull(otelSpans.inputTokens), isNotNull(otelSpans.outputTokens)),
      ),
    )
    .groupBy(otelSpans.model)
    .orderBy(desc(calls), asc(otelSpans.model))
    .limit(MAX_SEEN_MODELS);
  const eventRows = await db
    .select({ model: sql<string>`${events.model}`, calls, unpricedCalls: unpriced(events.costUsd) })
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        gte(sql`coalesce(${events.occurredAt}, ${events.receivedAt})`, since),
        isNotNull(events.model),
        or(isNotNull(events.inputTokens), isNotNull(events.outputTokens)),
      ),
    )
    .groupBy(events.model)
    .orderBy(desc(calls), asc(events.model))
    .limit(MAX_SEEN_MODELS);

  const byModel = new Map<string, SeenModel>();
  for (const row of [...spanRows, ...eventRows]) {
    if (!byModel.has(row.model))
      byModel.set(row.model, {
        model: row.model,
        calls: row.calls,
        unpricedCalls: row.unpricedCalls,
      });
  }
  return [...byModel.values()]
    .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model))
    .slice(0, MAX_SEEN_MODELS);
}
