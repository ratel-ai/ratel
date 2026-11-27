import { type RqlExecution, type RqlExecutor, RqlSetupError } from "../ports/executor";

/**
 * The `RqlExecutor` over a node-postgres pool (the RQL pool of `platform/db/rql-pool.ts`). One
 * connection per run, one transaction per connection:
 * `BEGIN READ ONLY`, `SET LOCAL ROLE ratel_rql`, the project and the timeout with
 * `set_config(..., true)` as bound values, the query, then `ROLLBACK`: a run never commits.
 */

/** The role of migration 0057_rql_views: USAGE on the schema `rql` and SELECT on its views only. */
export const RQL_ROLE = "ratel_rql";

/** The transaction setting the `rql` views filter on. */
export const RQL_PROJECT_SETTING = "rql.project_id";

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
      const client = await pool.connect().catch((error: unknown) => {
        throw new RqlSetupError(error);
      });
      try {
        await setUp(client, run);
        const result = await client.query({
          text: run.sql,
          values: [...run.params],
          rowMode: "array",
        });
        return result.rows as unknown[][];
      } finally {
        client.release(await rollBack(client));
      }
    },
  };
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
