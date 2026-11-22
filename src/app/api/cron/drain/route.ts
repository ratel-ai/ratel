import { startBackgroundDrain } from "@/lib/jobs/background-drain";
import { withRequestLog } from "@/lib/platform/request-log";

export const runtime = "nodejs";
// No `maxDuration`: the handler answers in milliseconds and the tick runs in `after()`. Its limit
// is the watchdog in `lib/jobs/background-drain.ts` (`CRON_DRAIN_TIMEOUT_MS`), as upstream.

/**
 * GET /api/cron/drain: one tick of background work (`lib/jobs/drain.ts`): the registered
 * before-steps, the job drain, the registered after-steps. The open-source edition never calls
 * it; its in-process scheduler runs the same tick every minute. An operator who sets
 * `RATEL_CRON=external` calls it from their own scheduler every minute, with `CRON_SECRET` as
 * a bearer; without a secret the route answers 401. Why every minute: `after()` drains a
 * project's jobs right after the enqueue response, but a cut-short function can leave jobs
 * `queued`, and the safety-net enqueues and self-throttled sweeps live in the tick.
 *
 * Answers 202 at once, so a scheduler never times out and retries into overlapping drains
 * (`lib/jobs/background-drain.ts`): the tick runs after the response, one at a time per process,
 * and logs `drain_completed`, `drain_failed` or `drain_timed_out`; a tick that finds the process
 * busy logs `drain_skipped_busy`. An API-only process (`APP_ROLE=api`) answers
 * `{ ok: true, skipped: "worker" }` and runs nothing: the worker sweeps on its own timer.
 */
export const GET = withRequestLog(handleGet);

async function handleGet(req: Request) {
  return startBackgroundDrain(req);
}
