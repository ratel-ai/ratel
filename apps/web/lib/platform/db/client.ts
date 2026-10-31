import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as tables from "@/lib/platform/db/tables";
import { getLogger, type LogError } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";

export interface PoolErrorObservabilityDeps {
  logError: LogError;
  reportServerException: typeof reportServerException;
}

const logger = getLogger("db");
const defaultPoolErrorDeps: PoolErrorObservabilityDeps = {
  logError: (message, error, fields) => logger.error({ ...fields, err: error }, message),
  reportServerException,
};

/**
 * Lazily-initialized drizzle client over node-postgres. Lazy so that merely importing this
 * module never requires DATABASE_URL (builds stay green before a database exists), and the
 * pool does not open a socket until the first query. The L1 tables are attached so the
 * client's type matches a test PGlite built the same way; modules import their own fragments
 * for the query builder, which is all the app uses.
 */
type Db = ReturnType<typeof createDb>;

/**
 * TLS: local plaintext Postgres gets none; anything else gets TLS without certificate pinning.
 * Override with DATABASE_SSL = "disable" | "require".
 */
export function sslConfig(
  url: string,
  mode = process.env.DATABASE_SSL,
): false | { rejectUnauthorized: boolean } {
  const resolved = mode ?? (/localhost|127\.0\.0\.1/.test(url) ? "disable" : "require");
  return resolved === "disable" ? false : { rejectUnauthorized: false };
}

function createDb(url: string) {
  const pool = new Pool({
    connectionString: url,
    ssl: sslConfig(url),
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  });
  attachPoolErrorHandler(pool);
  return drizzle({ client: pool, schema: tables });
}

export function attachPoolErrorHandler(
  pool: Pick<Pool, "on">,
  deps: PoolErrorObservabilityDeps = defaultPoolErrorDeps,
): void {
  pool.on("error", (error) => {
    deps.logError("idle pool client error", error);
    try {
      deps.reportServerException(error, "system:database", { component: "pg_pool" });
    } catch (captureError) {
      deps.logError("exception capture failed", captureError);
    }
  });
}

let _db: Db | undefined;

/** Whether a database connection is configured, so pages can degrade before one exists. */
export function isDbConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

export function getDb(): Db {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set: provision a Postgres database and add it to the environment.",
      );
    }
    _db = createDb(url);
  }
  return _db;
}
