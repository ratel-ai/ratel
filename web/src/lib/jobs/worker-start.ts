import { workerLanes } from "@/lib/composition/registry";
import type { WorkerLane } from "@/lib/contracts/registry";
import { runDrainTick } from "@/lib/jobs/drain";
import { type DrainObserverDeps, drainTimeoutMs, timedDrain } from "@/lib/jobs/drain-observer";
import { LONG_JOB_KINDS, RUN_IMPORT_JOB, SANDBOX_IMAGE_BUILD_JOB } from "@/lib/jobs/kinds";
import { drainProjectJobs } from "@/lib/jobs/store";
import { startWorker, type WorkerDeps, type WorkerHandle } from "@/lib/jobs/worker";
import { getDb } from "@/lib/platform/db/client";
import { loadTopQueries, resetQueryStats } from "@/lib/platform/db/top-queries";
import { getLogger } from "@/lib/platform/logger";

const logger = getLogger("jobs/worker");

const GLOBAL_KEY = Symbol.for("ratel.platform.worker");

export interface BackgroundWorkerDeps {
  /** The analysis lane: every queued kind but the long ones. */
  drain: WorkerDeps["drain"];
  /** The import lane (RC-40): `run_import` only, so a long import never holds analysis back. */
  drainImports?: WorkerDeps["drainImports"];
  /** The build lane: `sandbox_image_build` only, so the builds of one project hold back no import. */
  drainBuilds?: WorkerDeps["drainBuilds"];
  /** The registrations' lanes (the ingest queue's persist lane, RTL-314). Read once, at start. */
  lanes?: () => readonly WorkerLane[];
  /** The day's most expensive statements, logged once a day (`reportTopQueries`). */
  reportTopQueries?: () => Promise<void>;
  /** One cron tick (`runDrainTick`): the sweeps and safety nets, plus a drain. */
  tick: () => Promise<{ ok: boolean; error?: string }>;
  startWorker: typeof startWorker;
  on: (signal: "SIGTERM" | "SIGINT", listener: () => void) => void;
  exit: (code: number) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
}

/** The job kinds of each lane. */
export const LANE_KINDS = {
  analysis: { except: LONG_JOB_KINDS },
  imports: { only: [RUN_IMPORT_JOB] },
  builds: { only: [SANDBOX_IMAGE_BUILD_JOB] },
} as const;

const defaultDeps = (): BackgroundWorkerDeps => ({
  drain: () => drainProjectJobs(undefined, undefined, { kinds: LANE_KINDS.analysis }),
  drainImports: () => drainProjectJobs(undefined, undefined, { kinds: LANE_KINDS.imports }),
  drainBuilds: () => drainProjectJobs(undefined, undefined, { kinds: LANE_KINDS.builds }),
  lanes: () => workerLanes(),
  reportTopQueries: () => reportTopQueries(),
  tick: workerTick(),
  startWorker,
  on: (signal, listener) => process.on(signal, listener),
  exit: (code) => process.exit(code),
  warn: (fields, message) => logger.warn(fields, message),
});

/**
 * Start the background worker in this process (APP_ROLE=worker), once: a second
 * call returns the worker already running, so a dev server's module reloads do
 * not stack loops. The sweep runs the cron tick in this process, so it needs no
 * `CRON_SECRET`.
 *
 * On SIGTERM or SIGINT the loop is told to stop and the process exits 0 once the
 * step in flight has finished; a second signal exits at once. That needs
 * `NEXT_MANUAL_SIG_HANDLE=true`: without it Next's own handling ends the process
 * first. A job cut short is marked as an error by the reaper
 * (`reapStaleRunningJobs`); the cron safety nets queue its work again.
 *
 * Three lanes: analysis drains every kind but the long ones, and imports (`run_import`) and image
 * builds, which can take many minutes, each drain in a lane of their own. Once a day it logs the database's
 * most expensive statements (`reportTopQueries`).
 *
 * `beforeExit` runs between the last step and the exit: the self-telemetry flush, when this
 * process exports its own traces and logs. A failure there never keeps the process alive.
 */
export function startBackgroundWorker(
  deps: BackgroundWorkerDeps = defaultDeps(),
  options: {
    beforeExit?: () => Promise<void>;
    /** A persist-only process (APP_ROLE=persist): the registrations' lanes and nothing else. */
    lanesOnly?: boolean;
  } = {},
): WorkerHandle {
  const globals = globalThis as Record<symbol, WorkerHandle | undefined>;
  const existing = globals[GLOBAL_KEY];
  if (existing) return existing;
  const { drainImports, drainBuilds } = deps;
  const lanesOnly = options.lanesOnly === true;
  const handle = deps.startWorker({
    ...(lanesOnly ? { analysis: false } : {}),
    extraLanes: deps.lanes?.() ?? [],
    drain: () => deps.drain(),
    ...(drainImports ? { drainImports: () => drainImports() } : {}),
    ...(drainBuilds ? { drainBuilds: () => drainBuilds() } : {}),
    sweep: async () => {
      const tick = await deps.tick();
      if (!tick.ok) deps.warn({ error: tick.error }, "worker sweep finished with an error");
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  globals[GLOBAL_KEY] = handle;
  const topQueries = deps.reportTopQueries;
  const report =
    topQueries && !lanesOnly ? setInterval(() => void topQueries(), TOP_QUERIES_EVERY_MS) : null;
  report?.unref();
  let stopping = false;
  const stop = () => {
    if (stopping) return deps.exit(1);
    stopping = true;
    if (report) clearInterval(report);
    void handle
      .stop()
      .then(async () => {
        try {
          await options.beforeExit?.();
        } catch (error) {
          deps.warn({ error: String(error) }, "worker flush before exit failed");
        }
      })
      .then(() => deps.exit(0));
  };
  deps.on("SIGTERM", stop);
  deps.on("SIGINT", stop);
  return handle;
}

/** Once a day per worker (one in each environment): see reportTopQueries. */
export const TOP_QUERIES_EVERY_MS = 24 * 60 * 60_000;

/**
 * The day's most expensive statements as `db_top_query` lines (RC-214), then a reset so
 * tomorrow's lines cover tomorrow. Read in Datadog by @total_ms and @disk_reads; the query text
 * is Postgres's normalized form ($1 for values). Without `pg_stat_statements` it warns once a
 * day and does nothing; it never throws.
 */
export async function reportTopQueries(
  db: Parameters<typeof loadTopQueries>[0] = getDb(),
  log: Pick<ReturnType<typeof getLogger>, "info" | "warn" | "error"> = logger,
): Promise<void> {
  try {
    const top = await loadTopQueries(db);
    if (!top) {
      log.warn({}, "pg_stat_statements is not available");
      return;
    }
    for (const [index, query] of top.entries()) {
      log.info({ rank: index + 1, ...query }, "db_top_query");
    }
    await resetQueryStats(db);
  } catch (err) {
    log.error({ err }, "top queries report failed");
  }
}

/**
 * The worker's sweep: the cron tick, observed like the route's tick (`drain-observer.ts`), so it
 * logs the `drain_completed` heartbeat and `job_queue_lagging` the deployment's monitors read.
 * Upstream's `workerSweep`. A tick that hangs would stop the analysis lane, so it has a limit
 * that restarts on each finished job (`CRON_DRAIN_TIMEOUT_MS`, see `timedDrain`). A tick that
 * throws, times out or is skipped reads as a failed one.
 */
export function workerTick(
  run: (onProgress: () => void) => Promise<{ ok: boolean; error?: string }> = (onProgress) =>
    runDrainTick(undefined, onProgress),
  observer?: DrainObserverDeps,
  timeoutMs: number = drainTimeoutMs(),
): () => Promise<{ ok: boolean; error?: string }> {
  const tick = timedDrain(run, timeoutMs, observer);
  return async () => (await tick()) ?? { ok: false, error: "drain did not finish" };
}

/** Stop the worker started here, after its step in flight, and forget it. */
export async function stopBackgroundWorker(): Promise<void> {
  const globals = globalThis as Record<symbol, WorkerHandle | undefined>;
  const handle = globals[GLOBAL_KEY];
  globals[GLOBAL_KEY] = undefined;
  await handle?.stop();
}
