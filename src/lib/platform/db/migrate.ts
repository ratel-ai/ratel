import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { sslConfig } from "@/lib/platform/db/client";

/** Where the open-source migrations live; `MIGRATIONS_DIR` overrides it in the image. */
export const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** One advisory lock key for every Ratel replica that migrates the same database. */
export const MIGRATION_LOCK_KEY = 0x52617465; // "Rate"

export type MigrateOptions = {
  url: string;
  migrationsFolder?: string;
  sslMode?: string;
};

/** The one query surface the lock needs; `pg`'s client and a test double both have it. */
export type LockClient = {
  query(text: string, values?: unknown[]): Promise<unknown>;
};

/**
 * Hold a session-level advisory lock on `client` while `run` executes. drizzle's node-postgres
 * migrator takes no lock of its own: two replicas booting on an empty database would both see an
 * empty journal, one would create the tables and the other would fail on them. Serialized here,
 * the second waits, then finds the journal filled and applies nothing. The lock is released
 * on the same connection whether `run` succeeds or throws.
 */
export async function withMigrationLock<T>(client: LockClient, run: () => Promise<T>): Promise<T> {
  await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  try {
    return await run();
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
  }
}

/**
 * Apply pending migrations under the advisory lock. The `__drizzle_migrations` journal makes
 * re-runs idempotent. Throws on failure so a caller can refuse to serve against a mismatched
 * schema.
 */
export async function runMigrations({
  url,
  migrationsFolder,
  sslMode,
}: MigrateOptions): Promise<void> {
  const pool = new Pool({ connectionString: url, ssl: sslConfig(url, sslMode), max: 1 });
  try {
    const client = await pool.connect();
    try {
      await withMigrationLock(client, () =>
        migrate(drizzle(client), {
          migrationsFolder:
            migrationsFolder ?? process.env.MIGRATIONS_DIR ?? DEFAULT_MIGRATIONS_DIR,
        }),
      );
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/**
 * Whether the server migrates at boot. `DATABASE_MIGRATE_ON_BOOT=1` turns it on and `0` off.
 * Unset: on for the open-source edition, where a server that starts against an empty schema
 * and fails on the first request is the worse default; off for Cloud, which migrates as a
 * deploy step. Never without a `DATABASE_URL`.
 */
export function migrateOnBootEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!env.DATABASE_URL) return false;
  const flag = env.DATABASE_MIGRATE_ON_BOOT?.trim();
  if (flag === "1") return true;
  if (flag === "0") return false;
  return (env.RATEL_COMPOSITION || "oss") === "oss";
}
