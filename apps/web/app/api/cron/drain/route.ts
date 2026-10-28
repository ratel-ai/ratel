import { drainCron } from "@/lib/jobs/drain";
import { withRequestLog } from "@/lib/platform/request-log";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/cron/drain: job durability, recurring categorization, scheduled sweeps,
 * and telemetry retention. EventBridge hits this route every minute (see
 * infra/module/scheduler.tf); that tight cadence serves:
 *  - `after()` drains a project's jobs right after the enqueue response, but if
 *    that function is cut short (timeout/crash) jobs can linger `queued`; this
 *    re-drains all projects' queued jobs (why it wants a per-minute tick).
 *  - search queries stream in continuously, so nothing else enqueues
 *    `categorize_queries` on a schedule: `enqueueDueQueryCategorizations` does that
 *    here, before the drain, once a project has accumulated
 *    `QUERY_INTENTS_TRIGGER_COUNT` un-categorized search queries and has no run in
 *    flight. Tool Explorer reads the asks those runs record.
 *  - the safety-net enqueues and self-throttled sweeps in `lib/cron/drain.ts`
 *    (intent graph folds, Agent health turns and signals, match quality), which
 *    run before or after the drain.
 *  - expired OTel spans are deleted in bounded batches by server receipt time.
 * Guarded by `CRON_SECRET` when set (EventBridge sends it as a Bearer).
 */
export const GET = withRequestLog(handleGet);

async function handleGet(req: Request) {
  return drainCron(req);
}
