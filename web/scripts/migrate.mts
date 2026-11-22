/**
 * Apply pending migrations from lib/platform/db/migrations.
 *
 *   pnpm --filter @ratel/platform migrate        against DATABASE_URL (no-op when unset)
 *
 * In the image the server can do the same at boot with DATABASE_MIGRATE_ON_BOOT=1; this script
 * is for operators who migrate as a separate step. A failure exits non-zero so a deploy never
 * serves against a mismatched schema.
 */
import { runMigrations } from "../lib/platform/db/migrate";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("[migrate] DATABASE_URL not set; skipping migrations");
    return;
  }
  console.log(`[migrate] applying pending migrations (env: ${process.env.APP_ENV ?? "development"})`);
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
