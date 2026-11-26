import { shapedRowBytes } from "../domain/result";
import {
  RqlBusyError,
  type RqlExecution,
  type RqlExecutor,
  RqlSetupError,
} from "../ports/executor";

/**
 * The `RqlExecutor` over a node-postgres pool (the RQL pool of `platform/db/rql-pool.ts`). One
 * connection per run, one transaction per connection:
 * `BEGIN READ ONLY`, `SET LOCAL ROLE ratel_rql`, the project and the timeout with
 * `set_config(..., true)` as bound values, the query through a cursor, then `ROLLBACK`: a run
 * never commits. The cursor gives the rows `FETCH_ROWS` at a time, and the adapter stops reading
 * once they pass `maxBytes`: one hostile query cannot fill the memory of the server.
 */

/** The role of migration 0057_rql_views: USAGE on the schema `rql` and SELECT on its views only. */
export const RQL_ROLE = "ratel_rql";

/** The transaction setting the `rql` views filter on. */
export const RQL_PROJECT_SETTING = "rql.project_id";

/** The cursor of a run: it lives inside the transaction, and the rollback closes it. */
const CURSOR = "rql_rows";

/** The rows of one FETCH. */
export const FETCH_ROWS = 100;

/** The message of `pg-pool` when no connection came free within `connectionTimeoutMillis`. */
const CONNECT_TIMEOUT = /timeout exceeded when trying to connect/i;

/** What the adapter needs of a pool; `pg.Pool` has it. */
export interface RqlPool {
  connect(): Promise<RqlPoolClient>;
}

export interface RqlPoolClient {
  query(query: {
    text: string;
    values?: unknown[];
    rowMode?: "array";
  }): Promise<{ rows: unknown[] }>;
  /** A truthy argument destroys the connection instead of returning it to the pool. */
  release(destroy?: boolean | Error): void;
}

export function createPgRqlExecutor(pool: RqlPool): RqlExecutor {
  return {
    async execute(run) {
      const started = Date.now();
      const client = await pool.connect().catch((error: unknown) => {
        if (error instanceof Error && CONNECT_TIMEOUT.test(error.message)) {
          throw new RqlBusyError(error);
        }
        throw new RqlSetupError(error);
      });
      try {
        await setUp(client, run);
        await client.query({
          text: `declare ${CURSOR} no scroll cursor for ${run.sql}`,
          values: [...run.params],
        });
        return await readRows(client, run, started);
      } finally {
        client.release(await rollBack(client));
      }
    },
  };
}

/** The SQLSTATE of a statement Postgres stopped on its timeout, as the runner maps it. */
const QUERY_CANCELED = "57014";

/**
 * FETCH until the cursor ends, or until the rows pass `maxBytes`. Postgres times each FETCH on its
 * own, so before each one the timeout is set to what is left of the run's `timeoutMs`: the whole
 * read stops at the timeout, as one plain query would.
 */
async function readRows(
  client: RqlPoolClient,
  { maxBytes, timeoutMs }: RqlExecution,
  started: number,
): Promise<unknown[][]> {
  const rows: unknown[][] = [];
  let bytes = 0;
  for (;;) {
    const left = timeoutMs - (Date.now() - started);
    if (left <= 0)
      throw Object.assign(new Error("canceling statement due to statement timeout"), {
        code: QUERY_CANCELED,
      });
    await client.query({
      text: "select set_config('statement_timeout', $1, true)",
      values: [String(left)],
    });
    const batch = (
      await client.query({ text: `fetch ${FETCH_ROWS} from ${CURSOR}`, rowMode: "array" })
    ).rows as unknown[][];
    for (const row of batch) {
      rows.push(row);
      bytes += shapedRowBytes(row);
      if (bytes > maxBytes) return rows;
    }
    if (batch.length < FETCH_ROWS) return rows;
  }
}

async function setUp(client: RqlPoolClient, run: RqlExecution): Promise<void> {
  try {
    await client.query({ text: "begin read only" });
    await client.query({ text: `set local role ${RQL_ROLE}` });
    await client.query({
      text: "select set_config($1, $2, true), set_config('statement_timeout', $3, true)",
      values: [RQL_PROJECT_SETTING, run.projectId, String(run.timeoutMs)],
    });
  } catch (error) {
    throw new RqlSetupError(error);
  }
}

/** Ends the transaction. A connection that cannot even roll back is destroyed, not reused. */
async function rollBack(client: RqlPoolClient): Promise<Error | undefined> {
  try {
    await client.query({ text: "rollback" });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
