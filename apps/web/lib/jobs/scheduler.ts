/**
 * The in-process replacement for an external cron: the open-source edition runs the drain tick
 * from inside the server every minute, so a self-hoster needs no scheduler of their own. Cloud
 * keeps its external caller (`RATEL_CRON=external`) and never starts this.
 *
 * Single-flight (a slow tick is never overlapped), `unref`'d (it never keeps the process alive),
 * and guarded by a process-global handle so a dev server's module reloads do not stack timers.
 * Several replicas may each run it: the claim is atomic and the steps are idempotent.
 */
export type SchedulerDeps = {
  tick: () => Promise<unknown>;
  intervalMs?: number;
  /** Run a tick as soon as the scheduler starts, before the first interval. */
  immediate?: boolean;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  onError?: (error: unknown) => void;
};

export type SchedulerHandle = {
  stop(): void;
  /** Run a tick now, or wait for the one in flight. */
  tickNow(): Promise<void>;
  readonly running: boolean;
};

export const DEFAULT_INTERVAL_MS = 60_000;
const GLOBAL_KEY = Symbol.for("ratel.platform.scheduler");

export function createScheduler(deps: SchedulerDeps): SchedulerHandle {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const set = deps.setInterval ?? setInterval;
  const clear = deps.clearInterval ?? clearInterval;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const tickNow = (): Promise<void> => {
    if (inFlight) return inFlight;
    // An async IIFE starts the tick synchronously, so `running` is true the moment it is asked for.
    inFlight = (async () => {
      try {
        await deps.tick();
      } catch (error) {
        deps.onError?.(error);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const timer = set(() => {
    if (!stopped) void tickNow();
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  if (deps.immediate !== false) void tickNow();

  return {
    stop() {
      stopped = true;
      clear(timer);
    },
    tickNow,
    get running() {
      return inFlight !== null;
    },
  };
}

/** Start once per process; a second call returns the handle already running. */
export function startInProcessScheduler(deps: SchedulerDeps): SchedulerHandle {
  const globals = globalThis as Record<symbol, SchedulerHandle | undefined>;
  const existing = globals[GLOBAL_KEY];
  if (existing) return existing;
  const handle = createScheduler(deps);
  globals[GLOBAL_KEY] = handle;
  return handle;
}

export function stopInProcessScheduler(): void {
  const globals = globalThis as Record<symbol, SchedulerHandle | undefined>;
  globals[GLOBAL_KEY]?.stop();
  globals[GLOBAL_KEY] = undefined;
}

/**
 * `RATEL_CRON=inprocess` runs the tick here; `external` leaves it to a caller of
 * `GET /api/cron/drain`. Unset: in process for the open-source edition, external for Cloud.
 */
export function inProcessCronEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const mode = env.RATEL_CRON?.trim().toLowerCase();
  if (mode === "inprocess") return true;
  if (mode === "external") return false;
  return (env.RATEL_COMPOSITION || "oss") === "oss";
}
