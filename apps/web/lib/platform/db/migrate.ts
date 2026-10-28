import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { sslConfig } from "@/lib/platform/db/client";

/** Where the open-source migrations live; `MIGRATIONS_DIR` overrides it in the image. */
export const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export type MigrateOptions = {
  url: string;
  migrationsFolder?: string;
  sslMode?: string;
};

/**
 * Apply pending migrations. The `__drizzle_migrations` journal makes re-runs idempotent and
 * drizzle takes a lock, so concurrent boots do not double-apply. Throws on failure so a caller
 * can refuse to serve against a mismatched schema.
 */
export async function runMigrations({
  url,
  migrationsFolder,
  sslMode,
}: MigrateOptions): Promise<void> {
  const pool = new Pool({ connectionString: url, ssl: sslConfig(url, sslMode), max: 1 });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: migrationsFolder ?? process.env.MIGRATIONS_DIR ?? DEFAULT_MIGRATIONS_DIR,
    });
  } finally {
    await pool.end();
  }
}

/** Whether the operator asked the server to migrate at boot (`DATABASE_MIGRATE_ON_BOOT=1`). */
export function migrateOnBootEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.DATABASE_MIGRATE_ON_BOOT === "1" && !!env.DATABASE_URL;
}
