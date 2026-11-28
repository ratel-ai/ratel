import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/platform/db/client";
import type { PropertySource } from "./keys";
import { type PropertyState, tracePropertyKeys } from "./schema";
import { type PropertyColumn, standardProperty } from "./standard";

/** The Postgres side of trace property keys: record what ingest saw, list, change a state. */

export type PropertyDb = Pick<ReturnType<typeof getDb>, "select" | "update" | "transaction">;

/** One property of a project, as the settings section and the MCP tools show it. */
export interface TraceProperty {
  name: string;
  state: PropertyState;
  source: PropertySource;
  /** The summary column that holds a standard property; null when `properties` holds it. */
  column: PropertyColumn | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Approximate: spans and resources that carried it. */
  seenCount: number;
  indexedAt: Date | null;
}

export interface KeySighting {
  name: string;
  source: PropertySource;
  count: number;
}

/** A key one export wrote: its state, and whether this export added it. */
export interface RecordedKey {
  name: string;
  state: PropertyState;
  created: boolean;
}

/** The most keys of the user's own a project records. Standard properties are not counted. */
export const MAX_DETECTED_KEYS = 200;

const COLUMNS = {
  name: tracePropertyKeys.name,
  state: tracePropertyKeys.state,
  source: tracePropertyKeys.source,
  firstSeenAt: tracePropertyKeys.firstSeenAt,
  lastSeenAt: tracePropertyKeys.lastSeenAt,
  seenCount: tracePropertyKeys.seenCount,
  indexedAt: tracePropertyKeys.indexedAt,
};

/**
 * Record the keys one export carried: a new key is added (`indexed` for a standard property,
 * `detected` for any other) while the project has room for it, and a known one gets its count and
 * last sight. Never changes a state: a standard property a person turned off stays off. One
 * statement, under a per-project lock so that two exports cannot pass the bound together.
 */
export async function recordPropertyKeys(
  projectId: string,
  sightings: readonly KeySighting[],
  db: Pick<PropertyDb, "transaction"> = getDb(),
): Promise<RecordedKey[]> {
  if (sightings.length === 0) return [];
  const incoming = sql.join(
    sightings.map(
      ({ name, source, count }) => sql`(${name}::text, ${source}::text, ${count}::bigint)`,
    ),
    sql`, `,
  );
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`trace_property_keys:${projectId}`}, 0))`,
    );
    const result = await tx.execute(sql`
      with incoming (name, source, n) as (values ${incoming}),
      room as (
        select greatest(0, ${MAX_DETECTED_KEYS} - count(*))::int as n
        from trace_property_keys
        where project_id = ${projectId}::uuid and source = 'user'
      ),
      fresh as (
        select i.name, row_number() over (order by i.n desc, i.name) as rank
        from incoming i
        where i.source = 'user' and not exists (
          select 1 from trace_property_keys k
          where k.project_id = ${projectId}::uuid and k.name = i.name)
      )
      insert into trace_property_keys
        (project_id, name, state, source, seen_count, first_seen_at, last_seen_at, indexed_at)
      select ${projectId}::uuid, i.name,
        case when i.source = 'standard' then 'indexed' else 'detected' end,
        i.source, i.n, now(), now(),
        case when i.source = 'standard' then now() end
      from incoming i
      cross join room
      left join fresh f on f.name = i.name
      where f.name is null or f.rank <= room.n
      on conflict (project_id, name) do update set
        last_seen_at = excluded.last_seen_at,
        seen_count = trace_property_keys.seen_count + excluded.seen_count
      returning name, state, (xmax = 0) as created`);
    return (result as unknown as { rows: RecordedKey[] }).rows;
  });
}

/** The names a project indexes: what ingest stores values of. */
export async function loadIndexedProperties(
  projectId: string,
  db: Pick<PropertyDb, "select"> = getDb(),
): Promise<Set<string>> {
  const rows = await db
    .select({ name: tracePropertyKeys.name })
    .from(tracePropertyKeys)
    .where(and(eq(tracePropertyKeys.projectId, projectId), eq(tracePropertyKeys.state, "indexed")));
  return new Set(rows.map((row) => row.name));
}

/** The names of a project's properties that `properties` holds, by state: the most seen first. */
export interface StoredPropertyNames {
  indexed: string[];
  detected: string[];
}

/**
 * The names a query can read through `properties`, by state: RQL, the query object and the metric
 * form read them. A standard property that is a summary column is not one of them. One statement.
 */
export async function loadStoredPropertyNames(
  projectId: string,
  db: Pick<ReturnType<typeof getDb>, "execute"> = getDb(),
): Promise<StoredPropertyNames> {
  const result = await db.execute(sql`
    select name, state from trace_property_keys
    where project_id = ${projectId}::uuid
    order by seen_count desc, name`);
  const names: StoredPropertyNames = { indexed: [], detected: [] };
  for (const row of rowsOf<{ name: string; state: PropertyState }>(result)) {
    if (standardProperty(row.name)?.column) continue;
    names[row.state === "indexed" ? "indexed" : "detected"].push(row.name);
  }
  return names;
}

/**
 * Every property of a project: the indexed ones first, then the most seen. What the settings
 * section, the MCP tools and the filters of the later pages list.
 */
export async function listTraceProperties(
  projectId: string,
  db: Pick<PropertyDb, "select"> = getDb(),
): Promise<TraceProperty[]> {
  const rows = await db
    .select(COLUMNS)
    .from(tracePropertyKeys)
    .where(eq(tracePropertyKeys.projectId, projectId))
    .orderBy(
      asc(sql`case when ${tracePropertyKeys.state} = 'indexed' then 0 else 1 end`),
      desc(tracePropertyKeys.seenCount),
      asc(tracePropertyKeys.name),
    );
  return rows.map(shown);
}

export async function findTraceProperty(
  projectId: string,
  name: string,
  db: Pick<PropertyDb, "select"> = getDb(),
): Promise<TraceProperty | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(tracePropertyKeys)
    .where(and(eq(tracePropertyKeys.projectId, projectId), eq(tracePropertyKeys.name, name)));
  return row ? shown(row) : null;
}

/** How many properties of the user's own a project indexes: what the entitlement counts. */
export async function countUserIndexed(
  projectId: string,
  db: Pick<PropertyDb, "select"> = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tracePropertyKeys)
    .where(
      and(
        eq(tracePropertyKeys.projectId, projectId),
        eq(tracePropertyKeys.source, "user"),
        eq(tracePropertyKeys.state, "indexed"),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Index a property or stop it. Null when the project has no such property. */
export async function setTracePropertyState(
  projectId: string,
  name: string,
  state: PropertyState,
  db: Pick<PropertyDb, "update"> = getDb(),
): Promise<TraceProperty | null> {
  const [row] = await db
    .update(tracePropertyKeys)
    .set({
      state,
      // Kept when it stops: its values stay until they are erased.
      ...(state === "indexed"
        ? { indexedAt: sql`coalesce(${tracePropertyKeys.indexedAt}, now())` }
        : {}),
    })
    .where(and(eq(tracePropertyKeys.projectId, projectId), eq(tracePropertyKeys.name, name)))
    .returning(COLUMNS);
  return row ? shown(row) : null;
}

/** The property's values are erased: it holds none, whatever it held before. */
export async function clearIndexedAt(
  projectId: string,
  name: string,
  db: Pick<PropertyDb, "update"> = getDb(),
): Promise<void> {
  await db
    .update(tracePropertyKeys)
    .set({ indexedAt: null })
    .where(and(eq(tracePropertyKeys.projectId, projectId), eq(tracePropertyKeys.name, name)));
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? result) as T[];
}

function shown(row: Omit<TraceProperty, "column">): TraceProperty {
  return {
    ...row,
    seenCount: Number(row.seenCount),
    column: row.source === "standard" ? (standardProperty(row.name)?.column ?? null) : null,
  };
}
