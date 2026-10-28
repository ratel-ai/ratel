/**
 * Node-only boot. Kept out of instrumentation.ts so the Edge bundle never sees process.exit
 * (Next analyzes that file for both runtimes).
 *
 * Next logs an instrumentation failure and keeps serving, so exit here is deliberate: a wrong
 * RATEL_COMPOSITION must never become a healthy container.
 */
export async function assertComposition(): Promise<void> {
  try {
    await import("@/lib/composition");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * What the open-source edition does for itself at boot: apply migrations when asked
 * (`DATABASE_MIGRATE_ON_BOOT=1`) and run the cron tick in process (`RATEL_CRON=inprocess`, the
 * OSS default). A migration failure exits, like a bad composition: never serve a mismatched
 * schema. Nothing here runs without a DATABASE_URL.
 */
export async function bootBackground(): Promise<void> {
  const { migrateOnBootEnabled, runMigrations } = await import("@/lib/platform/db/migrate");
  if (migrateOnBootEnabled()) {
    try {
      await runMigrations({ url: process.env.DATABASE_URL as string });
    } catch (error) {
      console.error("[migrate] failed; refusing to serve against a mismatched schema");
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  }
  const { inProcessCronEnabled, startInProcessScheduler } = await import("@/lib/jobs/scheduler");
  if (inProcessCronEnabled() && process.env.DATABASE_URL) {
    const { runDrainTick } = await import("@/lib/jobs/drain");
    startInProcessScheduler({
      tick: () => runDrainTick(),
      onError: (error) => console.error("[cron] tick failed", error instanceof Error ? error.message : error),
    });
  }
}
