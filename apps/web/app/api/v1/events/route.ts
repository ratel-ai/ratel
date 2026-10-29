import { insertTraceEventRejects, insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { handleRuntimeEventsRequest } from "@/lib/ingest/trace-events/route-handler";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { createTokenBucketRateLimiter } from "@/lib/platform/rate-limit";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { trackServerEvent } from "@/lib/platform/telemetry";

export const runtime = "nodejs";

const runtimeEventsRateLimiter = createTokenBucketRateLimiter({
  limitPerMinute: 120,
  burst: 240,
});

/**
 * POST /api/v1/events: typed, quota-exempt runtime-event ingest. The trace-turn build, the
 * intent-graph fold and the intent-engine run are enqueued here once their modules land.
 */
export const POST = withRequestLog(handlePost);

async function handlePost(request: Request): Promise<Response> {
  return handleRuntimeEventsRequest(request, {
    resolveProjectFromBearer,
    getOrganizationByProjectId,
    insertTraceEvents,
    insertTraceEventRejects,
    rateLimiter: runtimeEventsRateLimiter,
    setRequestLogContext,
    trackServerEvent,
  });
}
