import { getLogger } from "@/lib/platform/logger";

const logger = getLogger("jobs/worker");

/** How often the worker looks for queued jobs when the last look found none. */
export const IDLE_POLL_MS = 3_000;
/** How often the worker runs the scheduled sweeps (what the cron tick runs today). */
export const SWEEP_EVERY_MS = 60_000;

export interface WorkerDeps {
  /** Claim and run queued jobs, fairly across projects; resolves with how many ran. */
  drain: () => Promise<{ done: number; failed: number }>;
  /** The cron drain's sweeps and safety nets, plus a drain. */
  sweep: () => Promise<void>;
  /**
   * Claim and run queued imports (RC-40), in a lane of their own: an import can
   * take many minutes, and must not hold up every other project's analysis or
   * the sweeps. Absent, imports go through `drain` like any job.
   */
  drainImports?: () => Promise<{ done: number; failed: number }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface WorkerHandle {
  /** Stop after the step in flight finishes. */
  stop: () => Promise<void>;
}

/**
 * The worker's loop (RC-32): one step at a time, so a worker process never
 * runs two drains at once. A step is a sweep when one is due, otherwise a
 * drain. After a drain that ran something it goes again at once, so a backlog
 * is worked through; after an empty one it waits a few seconds. A failing step
 * is logged and the loop keeps going.
 */
export function startWorker(deps: WorkerDeps): WorkerHandle {
  let stopping = false;
  let lastSweepAt = -Infinity;

  const lane = async (name: string, step: () => Promise<boolean>) => {
    while (!stopping) {
      let ranSomething = false;
      try {
        ranSomething = await step();
      } catch (error) {
        logger.error({ err: error, lane: name }, "background worker step failed");
      }
      if (!ranSomething && !stopping) await deps.sleep(IDLE_POLL_MS);
      // Always give the event loop a turn between steps, so a run of instant
      // steps can never starve timers, other lanes or the HTTP server.
      else await new Promise((resolve) => setImmediate(resolve));
    }
  };

  logger.info({}, "background worker started");
  const lanes = [
    lane("analysis", async () => {
      if (deps.now() - lastSweepAt >= SWEEP_EVERY_MS) {
        lastSweepAt = deps.now();
        await deps.sweep();
        return true;
      }
      const { done, failed } = await deps.drain();
      return done + failed > 0;
    }),
  ];
  const imports = deps.drainImports;
  if (imports) {
    lanes.push(
      lane("imports", async () => {
        const { done, failed } = await imports();
        return done + failed > 0;
      }),
    );
  }
  const all = Promise.all(lanes).then(() => logger.info({}, "background worker stopped"));

  return {
    stop: async () => {
      stopping = true;
      await all;
    },
  };
}
