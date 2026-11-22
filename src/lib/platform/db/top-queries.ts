import { sql } from "drizzle-orm";
import type { BoundReadDb } from "@/lib/platform/db/statement-timeout";

/** One statement's cost since the last reset, from pg_stat_statements. */
export interface TopQuery {
  calls: number;
  total_ms: number;
  mean_ms: number;
  rows: number;
  /** Shared buffers read from disk: what drained the disk credits in October. */
  disk_reads: number;
  /** Normalized by Postgres (literals become $1), cut to 500 characters. */
  query: string;
}

const QUERY_CHARS = 500;

/**
 * The statements that cost the database most since the last reset (RC-214),
 * by total execution time. Null when pg_stat_statements is missing or not
 * preloaded (local Postgres, PGlite), so callers can say so once and move on.
 */
export async function loadTopQueries(
  db: Pick<BoundReadDb, "execute">,
  limit = 15,
): Promise<TopQuery[] | null> {
  const [installed] = (
    await db.execute(
      sql`select exists (select 1 from pg_extension where extname = 'pg_stat_statements') as installed`,
    )
  ).rows as Array<{ installed: boolean }>;
  if (!installed?.installed) return null;
  try {
    const rows = (
      await db.execute(sql`
        select calls::bigint as calls, total_exec_time as total_ms, mean_exec_time as mean_ms,
          rows::bigint as rows, shared_blks_read::bigint as disk_reads, left(query, ${QUERY_CHARS}) as query
        from pg_stat_statements
        where dbid = (select oid from pg_database where datname = current_database())
        order by total_exec_time desc
        limit ${limit}
      `)
    ).rows as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      calls: Number(row.calls),
      total_ms: Math.round(Number(row.total_ms)),
      mean_ms: Math.round(Number(row.mean_ms) * 10) / 10,
      rows: Number(row.rows),
      disk_reads: Number(row.disk_reads),
      query: String(row.query),
    }));
  } catch (err) {
    // Installed but not preloaded: the view raises instead of answering.
    if (notPreloaded(err)) return null;
    throw err;
  }
}

/** The view's own error, which drizzle wraps in `cause`. */
function notPreloaded(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (/shared_preload_libraries/.test(e.message)) return true;
  }
  return false;
}

/** Start the next window: each daily report then covers one day. */
export async function resetQueryStats(db: Pick<BoundReadDb, "execute">): Promise<void> {
  await db.execute(sql`select pg_stat_statements_reset()`);
}
