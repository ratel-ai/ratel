import { migrateOnBootEnabled } from "@/lib/platform/db/migrate";
import { type AppRole, appRole } from "./role";
import { inProcessCronEnabled } from "./scheduler";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Who runs the minute tick in this process:
 * - `scheduler`: the in-process timer (`scheduler.ts`), the all-in-one default.
 * - `external`: nobody here; a caller of `GET /api/cron/drain` does.
 * - `worker`: the worker loop (`worker.ts`), which sweeps on its own timer.
 * - `none`: an API-only process, which leaves the tick to the worker.
 */
export type TickSource = "scheduler" | "external" | "worker" | "none";

export interface BootPlan {
  role: AppRole;
  /** Whether this process applies migrations before it serves. */
  migrate: boolean;
  tick: TickSource;
}

/**
 * What a process does for background work at boot, from `APP_ROLE` and `RATEL_CRON`
 * (docs/adr/0031-platform-background-worker.md). `RATEL_CRON` only decides for the all-in-one
 * process: the worker is its own clock in either mode, and an API-only process never ticks.
 * One service migrates: the worker never does, whatever `DATABASE_MIGRATE_ON_BOOT` says, so a
 * worker that starts first cannot race the web process to an empty schema.
 */
export function bootPlan(env: Environment = process.env): BootPlan {
  const role = appRole(env);
  const migrate = role !== "worker" && migrateOnBootEnabled(env);
  if (role === "worker") return { role, migrate, tick: "worker" };
  if (role === "api") return { role, migrate, tick: "none" };
  return { role, migrate, tick: inProcessCronEnabled(env) ? "scheduler" : "external" };
}
