import { after } from "next/server";
import { getConfig } from "@/config";
import type { LogFields } from "@/lib/platform/logger";
import { type DrainSummary, runDrainTick } from "./drain";
import {
  type DrainObserverDeps,
  defaultDrainObserverDeps,
  drainTimeoutMs,
  observeDrain,
  progressWatchdog,
} from "./drain-observer";
import { type AppRole, appRole } from "./role";

/**
 * The cron route's tick (owned port of upstream's `lib/cron/background-drain.ts`): answered at
 * once, drained after the response, one drain at a time per process, under a watchdog.
 *
 * A scheduler gives up on a slow answer and retries, while a drain routinely runs 30-100s, so a
 * tick run inside the request turns into overlapping drains, each holding database connections.
 * Here the tick is answered in milliseconds, and a tick that lands while this process is still
 * draining is skipped (`drain_skipped_busy`): the next one, a minute later, picks up the work. The
 * scheduler only ever sees the 202, so the outcome lives in the logs (`drain-observer.ts`).
 *
 * One deliberate difference: upstream lets any caller in when `CRON_SECRET` is unset. The route
 * is closed without one here, because an open route would let anyone drive background work,
 * including jobs that spend the operator's model keys; the open-source edition runs the tick in
 * process and never needs it.
 */
export interface BackgroundDrainDeps extends DrainObserverDeps {
  after: (callback: () => Promise<void>) => void;
  drain: (onProgress?: () => void) => Promise<DrainSummary>;
  secret: () => string | undefined;
  /** This process's role (`APP_ROLE`, `role.ts`). */
  role?: () => AppRole;
  /** The watchdog limit in ms; 0 turns it off. */
  timeoutMs: () => number;
}

const defaultDeps = (): BackgroundDrainDeps => ({
  ...defaultDrainObserverDeps,
  after: (callback) => after(callback),
  drain: (onProgress) => runDrainTick(undefined, onProgress),
  secret: () => getConfig().jobs.cronSecret,
  role: () => appRole(),
  timeoutMs: () => drainTimeoutMs(),
});

/**
 * The drain holding this process's slot, if any. Each run owns its own slot object, so a run the
 * watchdog gave up on can never free the slot of the run that replaced it.
 */
let current: { startedAt: number } | null = null;

/** GET /api/cron/drain: authorize, then start a drain after the response unless one is running. */
export async function startBackgroundDrain(
  req: Request,
  deps: BackgroundDrainDeps = defaultDeps(),
): Promise<Response> {
  const secret = deps.secret();
  if (!secret) return new Response("CRON_SECRET is not configured", { status: 401 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  // An API-only, ingest-only or persist-only process leaves the sweeps and the drain to the
  // worker, which runs them on its own timer.
  const role = deps.role?.();
  if (role === "api" || role === "ingest" || role === "persist")
    return Response.json({ ok: true, skipped: "worker" }, { status: 202 });
  if (current) {
    deps.log("info", { running_for_ms: Date.now() - current.startedAt }, "drain_skipped_busy");
    return Response.json({ ok: true, skipped: "busy" }, { status: 202 });
  }
  const slot = { startedAt: Date.now() };
  current = slot;
  deps.after(() => runDrain(slot, deps));
  return Response.json({ ok: true, started: true }, { status: 202 });
}

/** A tick's drain: `observeDrain` inside this process's slot, under the watchdog. */
async function runDrain(slot: { startedAt: number }, deps: BackgroundDrainDeps): Promise<void> {
  const release = () => {
    if (current === slot) current = null;
  };
  let timedOut = false;
  const limit = deps.timeoutMs();
  const watchdog = progressWatchdog(limit, slot.startedAt, deps, () => {
    timedOut = true;
    release();
    deps.log(
      "error",
      { duration_ms: Date.now() - slot.startedAt, timeout_ms: limit },
      "drain_timed_out",
    );
  });
  const fields = (): LogFields => ({ timed_out: timedOut });
  try {
    await observeDrain(() => deps.drain(watchdog.progress), deps, fields);
  } finally {
    watchdog.stop();
    release();
  }
}
