/**
 * Apply pending migrations from lib/platform/db/migrations.
 *
 *   pnpm --filter @ratel/platform migrate        against `database.url` (DATABASE_URL; no-op when unset)
 *
 * The settings come from src/config.ts (env and/or the CONFIG_PATH file). In the image the server
 * can do the same at boot with `database.migrateOnBoot` (DATABASE_MIGRATE_ON_BOOT=1); this script
 * is for operators who migrate as a separate step. A failure exits non-zero so a deploy never
 * serves against a mismatched schema.
 */
import { getConfig } from "../src/config";
import { runMigrations } from "../src/lib/platform/db/migrate";

async function main() {
  const config = getConfig();
  const url = config.database.url;
  if (!url) {
    console.log("[migrate] database.url (DATABASE_URL) not set; skipping migrations");
    return;
  }
  console.log(`[migrate] applying pending migrations (env: ${config.app.environment})`);
  await runMigrations({ url });
  console.log("[migrate] database is up to date");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[migrate] FAILED; refusing to run against a mismatched schema");
    console.error(err);
    process.exit(1);
  });
