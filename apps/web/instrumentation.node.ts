/**
 * Node-only boot. Kept out of instrumentation.ts so the Edge bundle never sees process.exit
 * (Next analyzes that file for both runtimes).
 *
 * Next logs an instrumentation failure and keeps serving, so exit here is deliberate: a wrong
 * RATEL_COMPOSITION must never become a healthy container.
 */
export async function assertComposition(): Promise<void> {
  try {
    const { composition } = await import("@/lib/composition");
    composition.session.assertConfigured?.();
    if (composition.connect) {
      const { createToolCorpus } = await import("@/lib/synthesis/tool-corpus");
      const { createImportedRuns } = await import("@/lib/ledger/imported-runs");
      composition.connect({ toolCorpus: createToolCorpus(), importedRuns: createImportedRuns() });
    }
    const { configuredOrganizationName } = await import("@/lib/platform/deployment-config");
    configuredOrganizationName();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * What the open-source edition does for itself at boot, by this process's role (`APP_ROLE`,
 * `lib/jobs/boot-plan.ts`): apply migrations (on by default for OSS,
 * `DATABASE_MIGRATE_ON_BOOT=0` opts out; the worker never migrates, the web process does),
 * then run the cron tick in process (`RATEL_CRON=inprocess`, the OSS default) or, as the
 * worker, the job loop. An API-only process starts neither: it only queues. A migration
 * failure or an external scheduler with no `CRON_SECRET` exits, like a bad composition: never
 * serve a misconfigured server. Nothing here runs without a DATABASE_URL.
 */
export async function bootBackground(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const { exposureWarnings } = await import("@/lib/platform/deployment-config");
  for (const warning of exposureWarnings()) console.warn(`[deployment] ${warning}`);
  const { bootPlan } = await import("@/lib/jobs/boot-plan");
  const plan = bootPlan();
  if (plan.migrate) {
    const { runMigrations } = await import("@/lib/platform/db/migrate");
    try {
      await runMigrations({ url: process.env.DATABASE_URL });
    } catch (error) {
      console.error("[migrate] failed; refusing to serve against a mismatched schema");
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else if (plan.role === "worker") {
    console.log("[migrate] skipped: the worker never migrates, the web process does");
  }
  const { assertCronConfig, startInProcessScheduler } = await import("@/lib/jobs/scheduler");
  try {
    assertCronConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  if (plan.tick === "scheduler") {
    const { runDrainTick } = await import("@/lib/jobs/drain");
    startInProcessScheduler({
      tick: () => runDrainTick(),
      onError: (error) =>
        console.error("[cron] tick failed", error instanceof Error ? error.message : error),
    });
  }
  if (plan.tick === "worker") {
    const { startBackgroundWorker } = await import("@/lib/jobs/worker-start");
    startBackgroundWorker();
  }
}
