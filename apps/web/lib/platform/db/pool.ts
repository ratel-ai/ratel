import type { Pool, PoolClient, PoolConfig } from "pg";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * How long a request waits for a pooled connection, or for a new one to open.
 * Without it a request waits forever, and when every pooled connection is stuck
 * (the 2026-10-27 outage) requests pile up until the task runs out of memory.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Client-side ceiling on any single query. A database restart can leave a
 * socket open on our side with no server behind it; the query on it never
 * answers. This turns that into an error, and `hardenPoolClients` then drops
 * the connection. Set well above the longest legitimate query, because it
 * cannot tell slow from dead. `statement_timeout` (lib/db/statement-timeout.ts)
 * is the server-side limit for reads that are merely slow.
 */
export const DEFAULT_QUERY_TIMEOUT_MS = 120_000;

/**
 * TCP keepalive starts probing after this much idle time, so a socket whose
 * server vanished fails on its own, even with no query running on it.
 */
export const KEEPALIVE_INITIAL_DELAY_MS = 10_000;

/**
 * Postgres cancels a statement this long before the client gives up on it, so
 * a query we stop waiting for does not keep running (and holding memory) on
 * the server. Shorter limits set per read or per job still win.
 */
const SERVER_CANCEL_LEAD_MS = 5_000;

export function poolConfig(
  url: string,
  ssl: PoolConfig["ssl"],
  env: Environment = process.env,
): PoolConfig {
  const queryTimeout = timeoutMs(env.DATABASE_QUERY_TIMEOUT_MS, DEFAULT_QUERY_TIMEOUT_MS);
  return {
    connectionString: url,
    ssl,
    max: Number(env.DATABASE_POOL_MAX ?? 10),
    connectionTimeoutMillis: timeoutMs(env.DATABASE_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS),
    query_timeout: queryTimeout,
    ...(queryTimeout > SERVER_CANCEL_LEAD_MS
      ? { statement_timeout: queryTimeout - SERVER_CANCEL_LEAD_MS }
      : {}),
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
  };
}

/**
 * A positive integer in milliseconds, or the default. `0` turns the timeout off
 * (pg reads 0 as "none"); unset or malformed values keep the default, so a typo
 * can never remove the guard.
 */
function timeoutMs(value: string | undefined, fallback: number): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export interface PoolClientObservabilityDeps {
  logWarn: (message: string, error: unknown) => void;
}

/**
 * Make sure a connection that stopped answering leaves the pool.
 *
 * A query that hits `query_timeout` only rejects; pg keeps it as the
 * connection's active query, so every later query on that client queues behind
 * it. Drizzle releases a transaction's client without an error, so the stuck
 * client would go back to the pool and stall the next request too. Destroying
 * the socket errors everything queued on it and marks the client unqueryable,
 * so the pool removes it on release and opens a fresh connection next time.
 *
 * Also gives every client an error listener. pg-pool only listens while a
 * client is idle, so a socket error on a checked-out client (keepalive
 * declaring the server gone) would otherwise be an unhandled 'error' event and
 * crash the process.
 */
export function hardenPoolClients(pool: Pick<Pool, "on">, deps: PoolClientObservabilityDeps): void {
  pool.on("connect", (client: PoolClient) => {
    client.on("error", (error) => deps.logWarn("pooled client connection error", error));
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as { query: unknown }).query = (...args: unknown[]) => {
      const result = query(...args);
      if (isPromise(result)) {
        result.then(undefined, (error: unknown) => {
          if (!isReadTimeout(error)) return;
          deps.logWarn("query read timeout, dropping the connection", error);
          dropConnection(client);
        });
      }
      return result;
    };
  });
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

function isReadTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === "Query read timeout";
}

function dropConnection(client: PoolClient): void {
  const stream = (client as unknown as { connection?: { stream?: { destroy?: () => void } } })
    .connection?.stream;
  stream?.destroy?.();
}
