import { drainCron } from "@/lib/jobs/drain";
import { withRequestLog } from "@/lib/platform/request-log";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/cron/drain: one tick of background work (`lib/jobs/drain.ts`): the registered
 * before-steps, the job drain, the registered after-steps. The open-source edition never calls
 * it; its in-process scheduler runs the same tick every minute. An operator who sets
 * `RATEL_CRON=external` calls it from their own scheduler every minute, with `CRON_SECRET` as
 * a bearer; without a secret the route answers 401. Why every minute: `after()` drains a
 * project's jobs right after the enqueue response, but a cut-short function can leave jobs
 * `queued`, and the safety-net enqueues and self-throttled sweeps live in the tick.
 */
export const GET = withRequestLog(handleGet);

async function handleGet(req: Request) {
  return drainCron(req);
}
