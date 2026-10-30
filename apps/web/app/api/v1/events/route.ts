import { insertTraceEventRejects, insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { handleRuntimeEventsRequest } from "@/lib/ingest/trace-events/route-handler";
import { scheduleProjectDrain } from "@/lib/jobs/route-helpers";
import { enqueueBuildTraceTurnsJob } from "@/lib/ledger/turns/queries";
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
 * POST /api/v1/events: typed, quota-exempt runtime-event ingest. A stored batch kicks the
 * turn-ledger build and drains it after the response. The intent-graph fold and the
 * intent-engine run are enqueued here once their modules land.
 */
export const POST = withRequestLog(handlePost);

async function handlePost(request: Request): Promise<Response> {
  return handleRuntimeEventsRequest(request, {
    resolveProjectFromBearer,
    getOrganizationByProjectId,
    insertTraceEvents,
    insertTraceEventRejects,
    rateLimiter: runtimeEventsRateLimiter,
    traceTurns: {
      enqueueBuild: (projectId) => enqueueBuildTraceTurnsJob(projectId),
      scheduleProjectDrain,
    },
    setRequestLogContext,
    trackServerEvent,
  });
}
