import { runDrainTick } from "@/lib/jobs/drain";
import { drainProjectJobs } from "@/lib/jobs/store";
import { startWorker, type WorkerDeps, type WorkerHandle } from "@/lib/jobs/worker";
import { getLogger } from "@/lib/platform/logger";

const logger = getLogger("jobs/worker");

const GLOBAL_KEY = Symbol.for("ratel.platform.worker");

export interface BackgroundWorkerDeps {
  drain: WorkerDeps["drain"];
  /** One cron tick (`runDrainTick`): the sweeps and safety nets, plus a drain. */
  tick: () => Promise<{ ok: boolean; error?: string }>;
  startWorker: typeof startWorker;
  on: (signal: "SIGTERM" | "SIGINT", listener: () => void) => void;
  exit: (code: number) => void;
  warn: (fields: Record<string, unknown>, message: string) => void;
}

const defaultDeps = (): BackgroundWorkerDeps => ({
  drain: () => drainProjectJobs(),
  tick: () => runDrainTick(),
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
 * `beforeExit` runs between the last step and the exit: the self-telemetry flush, when this
 * process exports its own traces and logs. A failure there never keeps the process alive.
 */
export function startBackgroundWorker(
  deps: BackgroundWorkerDeps = defaultDeps(),
  options: { beforeExit?: () => Promise<void> } = {},
): WorkerHandle {
  const globals = globalThis as Record<symbol, WorkerHandle | undefined>;
  const existing = globals[GLOBAL_KEY];
  if (existing) return existing;
  const handle = deps.startWorker({
    drain: () => deps.drain(),
    sweep: async () => {
      const tick = await deps.tick();
      if (!tick.ok) deps.warn({ error: tick.error }, "worker sweep finished with an error");
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  globals[GLOBAL_KEY] = handle;
  let stopping = false;
  const stop = () => {
    if (stopping) return deps.exit(1);
    stopping = true;
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

/** Stop the worker started here, after its step in flight, and forget it. */
export async function stopBackgroundWorker(): Promise<void> {
  const globals = globalThis as Record<symbol, WorkerHandle | undefined>;
  const handle = globals[GLOBAL_KEY];
  globals[GLOBAL_KEY] = undefined;
  await handle?.stop();
}
