import { type Config, getConfig } from "@/config";
import { migrateOnBootEnabled } from "@/lib/platform/db/migrate";
import { type AppRole, appRole } from "./role";
import { inProcessCronEnabled } from "./scheduler";

/**
 * Who runs the minute tick in this process:
 * - `scheduler`: the in-process timer (`scheduler.ts`), the all-in-one default.
 * - `external`: nobody here; a caller of `GET /api/cron/drain` does.
 * - `worker`: the worker loop (`worker.ts`), which sweeps on its own timer.
 * - `none`: an API-only or ingest-only process, which leaves the tick to the worker.
 * - `persist`: a persist-only process: no tick, only the ingest lane.
 */
export type TickSource = "scheduler" | "external" | "worker" | "persist" | "none";

export interface BootPlan {
  role: AppRole;
  /** Whether this process applies migrations before it serves. */
  migrate: boolean;
  tick: TickSource;
}

/**
 * What a process does for background work at boot, from `APP_ROLE` and `RATEL_CRON`
 * (docs/adr/0005-background-worker.md). `RATEL_CRON` only decides for the all-in-one
 * process: the worker is its own clock in either mode, and an API-only process never ticks.
 * One service migrates: the worker, the ingest-only and the persist-only processes never do,
 * whatever `DATABASE_MIGRATE_ON_BOOT` says, so one that starts first cannot race the web process
 * to an empty schema.
 */
export function bootPlan(config: Config = getConfig()): BootPlan {
  const role = appRole(config);
  const migrate = (role === "all" || role === "api") && migrateOnBootEnabled(config);
  if (role === "worker") return { role, migrate, tick: "worker" };
  if (role === "persist") return { role, migrate, tick: "persist" };
  if (role === "ingest") return { role, migrate, tick: "none" };
  if (role === "api") return { role, migrate, tick: "none" };
  return { role, migrate, tick: inProcessCronEnabled(config) ? "scheduler" : "external" };
}

/**
 * The boot line of a process that never migrates, or null for one that may. The worker's wording
 * is a contract: CI's compose check greps the worker's log for "the worker never migrates".
 */
export function skippedMigrationMessage(role: AppRole): string | null {
  if (role === "worker")
    return "[migrate] skipped: the worker never migrates, the web process does";
  if (role === "ingest" || role === "persist")
    return `[migrate] skipped: the ${role} process never migrates, the web process does`;
  return null;
}
