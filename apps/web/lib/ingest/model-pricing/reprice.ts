import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { loadPriceBook } from "@/lib/ingest/model-pricing/price-book";
import { projectModelPrices } from "@/lib/ingest/model-pricing/schema";
import { loadPriceOverrides } from "@/lib/ingest/model-pricing/store";
import { GEN_AI } from "@/lib/ingest/otlp/constants";
import { eventMetrics, events, otelSpans } from "@/lib/ingest/otlp/schema";
import { costFor, extendsByDate, type PriceBook, resolvePrice } from "@/lib/ingest/pricing";
import type { getDb } from "@/lib/platform/db/client";
import { projects } from "@/lib/platform/projects/schema";

/**
 * Re-price stored model calls (RC-482). Ingest prices a call once, with the
 * prices of that moment, and stores the cost on `otel_spans`, `events` and
 * `event_metrics`. A price added later (to the built-in table or as the
 * project's own) reaches stored rows only through here:
 *
 * - {@link repriceProjectModel}: after a project's price of a model changed,
 *   restate the rows that price key prices in the project.
 * - {@link repriceUnpriced}: give a cost to every row stored without one whose
 *   model has a price now (`scripts/backfill-costs.ts`).
 * - {@link repriceStored}: restate every row stored with a cost at the prices
 *   of now, after a price correction (`scripts/backfill-costs.ts --reprice`).
 *
 * Costs are computed exactly as ingest does: `costFor` with the project's
 * price book. A row is written only when its cost changes at the stored
 * `numeric(12,6)` precision, or when an event's `event_metrics` cost differs
 * from it, so a re-run writes nothing. Rows are read in id order, a page at a
 * time, and each page's `events` and `event_metrics` writes are one
 * transaction.
 */

export type RepriceDb = Pick<ReturnType<typeof getDb>, "select" | "execute" | "transaction">;

export interface RepriceResult {
  /** `otel_spans` rows whose cost changed. */
  spans: number;
  /** `events` rows (and their `event_metrics`) whose cost changed. */
  events: number;
}

export interface RepriceOptions {
  log?: { info: (line: string) => void };
}

/** What {@link repriceStored} changes (or would change) for one organization, model and table. */
export interface CostChange {
  organizationId: string;
  organizationSlug: string;
  model: string;
  table: "spans" | "events";
  /** Rows whose cost changes. */
  rows: number;
  /** Of those, rows whose model has no price now: their cost becomes null. */
  unpricedNow: number;
  /** The stored cost of those rows, in USD. */
  oldUsd: number;
  /** Their cost at the prices of now, in USD (an unpriced row counts 0). */
  newUsd: number;
}

const PAGE = 1_000;
const CACHE_WRITE_KEY = GEN_AI.usageCacheCreation;

/**
 * Restate the rows of one project that the price key `model` prices: `model`
 * and its dated ids, unless a longer key prices them (saving `gpt-4o` never
 * touches `gpt-4o-mini`). `version` is the saved row's `updated_at`, null
 * after a reset.
 *
 * Each page is priced and written under one lock per PROJECT, with the
 * project's price book read again under the lock: two runs for related keys
 * (`gpt-4o` and `gpt-4o-2024-08-06`) take turns, and each sees the other's
 * saved price, so neither writes the rows the other key prices. When a newer
 * save of `model` replaced this one, the run stops (`stale`) and leaves the
 * rows to the newer save's re-price.
 */
export async function repriceProjectModel(
  projectId: string,
  model: string,
  version: Date | null,
  db: RepriceDb,
  {
    log,
    beforeWrite,
  }: RepriceOptions & {
    /** Runs between reading a page and writing it: tests use it to land a concurrent save. */
    beforeWrite?: () => Promise<void>;
  } = {},
): Promise<RepriceResult & { stale: boolean }> {
  const write: PageWriter = async (rows, apply) => {
    await beforeWrite?.();
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`model-pricing:${projectId}`}, 0))`,
      );
      const [saved] = await tx
        .select({ updatedAt: projectModelPrices.updatedAt })
        .from(projectModelPrices)
        .where(
          and(eq(projectModelPrices.projectId, projectId), eq(projectModelPrices.model, model)),
        );
      if ((saved?.updatedAt.getTime() ?? null) !== (version?.getTime() ?? null)) return STALE;
      const book = { overrides: await loadPriceOverrides(projectId, tx) };
      const priced = rows.filter((row) => {
        if (!row.model || !extendsByDate(row.model, model)) return false;
        const key = resolvePrice(row.model, book)?.key ?? null;
        return key === null || key === model;
      });
      const updates = await changedCosts(priced, async () => book);
      if (updates.length > 0) await apply(tx, updates);
      return updates.length;
    });
  };
  const spans = await repriceSpans(
    db,
    and(eq(otelSpans.projectId, projectId), startsWith(otelSpans.model, model)),
    write,
    log,
  );
  if (spans === STALE) return { spans: 0, events: 0, stale: true };
  const repricedEvents = await repriceEvents(
    db,
    and(eq(events.projectId, projectId), startsWith(events.model, model)),
    write,
    log,
  );
  if (repricedEvents === STALE) return { spans, events: 0, stale: true };
  return { spans, events: repricedEvents, stale: false };
}

/**
 * Give a cost to stored calls that have none, in one project or in all of
 * them, wherever the model has a price now in the project's price book.
 * Calls of a model still without a price stay null.
 */
export async function repriceUnpriced(
  db: RepriceDb,
  { projectId, log }: RepriceOptions & { projectId?: string } = {},
): Promise<RepriceResult> {
  const prices = projectPrices(db);
  const write: PageWriter = async (rows, apply) => {
    const updates = await changedCosts(rows, prices);
    if (updates.length > 0) await db.transaction((tx) => apply(tx, updates));
    return updates.length;
  };
  const spans = await repriceSpans(
    db,
    and(isNull(otelSpans.costUsd), projectId ? eq(otelSpans.projectId, projectId) : undefined),
    write,
    log,
  );
  const repricedEvents = await repriceEvents(
    db,
    and(isNull(events.costUsd), projectId ? eq(events.projectId, projectId) : undefined),
    write,
    log,
  );
  return {
    spans: spans === STALE ? 0 : spans,
    events: repricedEvents === STALE ? 0 : repricedEvents,
  };
}

/**
 * Restate every stored call that has a cost at the prices of now, in one
 * project or in all of them, less the excluded organizations. A call whose
 * model has no price now loses its cost. With `dryRun` nothing is written:
 * the result says what would change, by organization, model and table. An
 * excluded id that names no organization fails the run before it reads a row.
 */
export async function repriceStored(
  db: RepriceDb,
  {
    projectId,
    excludeOrganizationIds = [],
    dryRun = false,
    log,
  }: RepriceOptions & {
    projectId?: string;
    excludeOrganizationIds?: readonly string[];
    dryRun?: boolean;
  } = {},
): Promise<RepriceResult & { changes: CostChange[] }> {
  await assertOrganizationsExist(db, excludeOrganizationIds);
  const prices = projectPrices(db);
  const owners = await projectOwners(db);
  const totals = new Map<string, CostChange>();
  const writer =
    (table: CostChange["table"]): PageWriter =>
    async (rows, apply) => {
      const updates = await changedCosts(rows, prices);
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const update of updates) tally(totals, owners, table, byId.get(update.id)!, update.cost);
      if (updates.length > 0 && !dryRun) await db.transaction((tx) => apply(tx, updates));
      return updates.length;
    };
  const scope = (column: typeof otelSpans.projectId | typeof events.projectId) =>
    and(
      projectId ? eq(column, projectId) : undefined,
      excludeOrganizationIds.length > 0
        ? notInArray(
            column,
            db
              .select({ id: projects.id })
              .from(projects)
              .where(inArray(projects.organizationId, [...excludeOrganizationIds])),
          )
        : undefined,
    );
  const spans = await repriceSpans(
    db,
    and(isNotNull(otelSpans.costUsd), scope(otelSpans.projectId)),
    writer("spans"),
    log,
  );
  const repricedEvents = await repriceEvents(
    db,
    and(isNotNull(events.costUsd), scope(events.projectId)),
    writer("events"),
    log,
  );
  const changes = [...totals.values()]
    .map((change) => ({ ...change, oldUsd: round(change.oldUsd), newUsd: round(change.newUsd) }))
    .sort(
      (a, b) =>
        a.organizationSlug.localeCompare(b.organizationSlug) ||
        a.model.localeCompare(b.model) ||
        a.table.localeCompare(b.table),
    );
  return {
    spans: spans === STALE ? 0 : spans,
    events: repricedEvents === STALE ? 0 : repricedEvents,
    changes,
  };
}

type PricesFor = (projectId: string) => Promise<PriceBook>;
type Owner = { id: string; slug: string };
type Executor = Pick<RepriceDb, "execute">;
type CostUpdate = { id: string; cost: string | null };
/**
 * Prices one page and writes the rows whose cost changed with `apply`.
 * Returns how many it wrote, or `STALE` when the page must not be written.
 */
type PageWriter = (
  rows: readonly PricedRow[],
  apply: (db: Executor, updates: readonly CostUpdate[]) => Promise<void>,
) => Promise<number | typeof STALE>;

const STALE = Symbol("stale");

interface PricedRow {
  id: string;
  projectId: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  written: string | null;
  costUsd: string | null;
  /** An event's `event_metrics` cost (the event's own cost when it has no metric row). Absent for spans. */
  metricCostUsd?: string | null;
}

async function repriceSpans(
  db: RepriceDb,
  where: SQL | undefined,
  write: PageWriter,
  log?: RepriceOptions["log"],
): Promise<number | typeof STALE> {
  let changed = 0;
  let after: string | null = null;
  for (;;) {
    const rows: PricedRow[] = await db
      .select({
        id: otelSpans.id,
        projectId: otelSpans.projectId,
        model: otelSpans.model,
        inputTokens: otelSpans.inputTokens,
        outputTokens: otelSpans.outputTokens,
        cachedTokens: otelSpans.cachedTokens,
        written: sql<string | null>`${otelSpans.attributes} ->> ${CACHE_WRITE_KEY}`,
        costUsd: otelSpans.costUsd,
      })
      .from(otelSpans)
      .where(and(where, hasUsage(otelSpans), after ? gt(otelSpans.id, after) : undefined))
      .orderBy(asc(otelSpans.id))
      .limit(PAGE);
    if (rows.length === 0) return changed;
    after = rows[rows.length - 1]!.id;
    const written = await write(rows, async (tx, updates) => {
      await tx.execute(sql`
        update ${otelSpans} as t set cost_usd = v.cost::numeric
        from (values ${valuesList(updates)}) as v(id, cost)
        where t.id = v.id::uuid`);
    });
    if (written === STALE) return STALE;
    changed += written;
    log?.info(`… spans: ${changed} with a new cost`);
  }
}

async function repriceEvents(
  db: RepriceDb,
  where: SQL | undefined,
  write: PageWriter,
  log?: RepriceOptions["log"],
): Promise<number | typeof STALE> {
  let changed = 0;
  let after: string | null = null;
  for (;;) {
    // The cache-write count is not an `events` column: ingest read it off the
    // anchor span, which the event keeps by trace and span id.
    const rows: PricedRow[] = await db
      .select({
        id: events.id,
        projectId: events.projectId,
        model: events.model,
        inputTokens: events.inputTokens,
        outputTokens: events.outputTokens,
        cachedTokens: events.cachedTokens,
        written: sql<string | null>`${otelSpans.attributes} ->> ${CACHE_WRITE_KEY}`,
        costUsd: events.costUsd,
        metricCostUsd: sql<
          string | null
        >`case when ${eventMetrics.eventId} is null then ${events.costUsd} else ${eventMetrics.costUsd} end`,
      })
      .from(events)
      .leftJoin(
        otelSpans,
        and(
          eq(otelSpans.projectId, events.projectId),
          eq(otelSpans.traceId, events.traceId),
          eq(otelSpans.spanId, events.spanId),
        ),
      )
      .leftJoin(eventMetrics, eq(eventMetrics.eventId, events.id))
      .where(and(where, hasUsage(events), after ? gt(events.id, after) : undefined))
      .orderBy(asc(events.id))
      .limit(PAGE);
    if (rows.length === 0) return changed;
    after = rows[rows.length - 1]!.id;
    const written = await write(rows, async (tx, updates) => {
      await tx.execute(sql`
        update ${events} as t set cost_usd = v.cost::numeric
        from (values ${valuesList(updates)}) as v(id, cost)
        where t.id = v.id::uuid`);
      await tx.execute(sql`
        update ${eventMetrics} as t set cost_usd = v.cost::numeric
        from (values ${valuesList(updates)}) as v(id, cost)
        where t.event_id = v.id::uuid`);
    });
    if (written === STALE) return STALE;
    changed += written;
    log?.info(`… events: ${changed} with a new cost`);
  }
}

/**
 * The rows whose cost, priced now, differs from the stored one at
 * `numeric(12,6)` precision, or from the stored `event_metrics` one: a run
 * cut short between the two writes left them apart.
 */
async function changedCosts(rows: readonly PricedRow[], prices: PricesFor): Promise<CostUpdate[]> {
  const out: CostUpdate[] = [];
  for (const row of rows) {
    const written = row.written === null ? null : Number(row.written);
    const cost = costFor(
      row.model,
      {
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        cached_tokens: row.cachedTokens,
        cache_write_tokens: Number.isFinite(written) ? written : null,
      },
      await prices(row.projectId),
    );
    const next = cost === null ? null : cost.toFixed(6);
    const stored = atPrecision(row.costUsd);
    const metric = row.metricCostUsd === undefined ? stored : atPrecision(row.metricCostUsd);
    if (next === stored && next === metric) continue;
    out.push({ id: row.id, cost: next });
  }
  return out;
}

function atPrecision(cost: string | null): string | null {
  return cost === null ? null : Number(cost).toFixed(6);
}

/**
 * Fails, naming them, when an id names no organization. Owned (ADR-0030): organizations are the
 * edition's, so an id is known when a project names it.
 */
async function assertOrganizationsExist(db: RepriceDb, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  // As text: an id that is not a uuid is unknown, not a query error.
  const found = await db
    .select({ id: sql<string>`${projects.organizationId}::text` })
    .from(projects)
    .where(inArray(sql`${projects.organizationId}::text`, [...ids]));
  const known = new Set(found.map((row) => row.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0)
    throw new Error(`--exclude-organization names no organization: ${unknown.join(", ")}`);
}

/** Each project's price book, read once per run. */
function projectPrices(db: RepriceDb): PricesFor {
  const cache = new Map<string, Promise<PriceBook>>();
  return (projectId) => {
    let prices = cache.get(projectId);
    if (!prices) {
      prices = loadPriceBook(projectId, db);
      cache.set(projectId, prices);
    }
    return prices;
  };
}

/**
 * Each project's organization, read once per run. Owned (ADR-0030): organizations are the
 * edition's, so the owner is the project's organization id, which also stands for its slug.
 */
async function projectOwners(db: RepriceDb): Promise<Map<string, Owner>> {
  const rows = await db
    .select({ projectId: projects.id, id: projects.organizationId })
    .from(projects);
  return new Map(rows.map((row) => [row.projectId, { id: row.id, slug: row.id }]));
}

/** Add one changed row to its organization, model and table. */
function tally(
  totals: Map<string, CostChange>,
  owners: Map<string, Owner>,
  table: CostChange["table"],
  row: PricedRow,
  next: string | null,
): void {
  const owner = owners.get(row.projectId) ?? { id: "unknown", slug: "unknown" };
  const model = row.model ?? "";
  const key = `${owner.id}\u0000${model}\u0000${table}`;
  const change = totals.get(key) ?? {
    organizationId: owner.id,
    organizationSlug: owner.slug,
    model,
    table,
    rows: 0,
    unpricedNow: 0,
    oldUsd: 0,
    newUsd: 0,
  };
  change.rows += 1;
  if (next === null) change.unpricedNow += 1;
  change.oldUsd += Number(row.costUsd ?? 0);
  change.newUsd += Number(next ?? 0);
  totals.set(key, change);
}

function round(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** Ingest prices a call only when it reported input or output tokens. */
function hasUsage(table: typeof otelSpans | typeof events): SQL | undefined {
  return and(
    isNotNull(table.model),
    or(isNotNull(table.inputTokens), isNotNull(table.outputTokens)),
  );
}

/** A cheap first cut: `column` starts with `model`. The exact rule (a dated id of the key) runs in code. */
function startsWith(column: typeof otelSpans.model | typeof events.model, model: string): SQL {
  return sql`left(${column}, char_length(${model})) = ${model}`;
}

function valuesList(updates: readonly CostUpdate[]): SQL {
  return sql.join(
    updates.map((update) => sql`(${update.id}, ${update.cost})`),
    sql`, `,
  );
}
