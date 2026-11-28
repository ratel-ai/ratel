import { Pool, type PoolConfig } from "pg";
import { type Config, getConfig } from "@/config";
import { attachPoolErrorHandler, sslConfig } from "@/lib/platform/db/client";
import { hardenPoolClients, poolConfig } from "@/lib/platform/db/pool";
import { getLogger } from "@/lib/platform/logger";

/**
 * The pool RQL queries run on: separate from the primary pool of `client.ts`, so a burst of RQL
 * queries can wait for one of its few connections but never takes one that ingest or a page needs.
 * The url is `database.rqlUrl` (RQL_DATABASE_URL), else `database.url` (DATABASE_URL).
 */

/**
 * The connections of the RQL pool, for all projects together: more than the queries one project
 * may run at the same time (`RQL_LIMITS.parallelQueriesPerProject`, 2), so one project never holds
 * every connection. A run that waits past the connect timeout gets `rql_busy`.
 */
export const RQL_POOL_MAX = 8;

/** Makes the pool; `new Pool` in production, a fake in tests. */
export type RqlPoolFactory<P extends Pick<Pool, "on">> = (config: PoolConfig) => P;

const logger = getLogger("db.rql");
let _pool: Pool | undefined;

/** The lazily opened RQL pool. Throws when neither RQL_DATABASE_URL nor DATABASE_URL is set. */
export function getRqlPool(): Pool {
  _pool ??= createRqlPool(getConfig(), (config) => new Pool(config));
  return _pool;
}

/** A new pool on the RQL url, with the timeouts of the primary pool and `RQL_POOL_MAX` clients. */
export function createRqlPool<P extends Pick<Pool, "on">>(
  config: Pick<Config, "database">,
  newPool: RqlPoolFactory<P>,
): P {
  const url = rqlDatabaseUrl(config);
  if (!url) {
    throw new Error(
      "RQL has no database: set RQL_DATABASE_URL or DATABASE_URL to a Postgres database.",
    );
  }
  const pool = newPool({
    ...poolConfig(url, sslConfig(url, config.database.ssl), config),
    max: RQL_POOL_MAX,
  });
  attachPoolErrorHandler(pool);
  hardenPoolClients(pool, { logWarn: (message, error) => logger.warn({ err: error }, message) });
  return pool;
}

/** The url RQL connects to: RQL_DATABASE_URL, else DATABASE_URL. */
export function rqlDatabaseUrl(config: Pick<Config, "database">): string | undefined {
  return config.database.rqlUrl ?? config.database.url;
}
