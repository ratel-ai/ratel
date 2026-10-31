import { insertTraceEventRejects, insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { handleRuntimeEventsRequest } from "@/lib/ingest/trace-events/route-handler";
import { scheduleProjectDrain } from "@/lib/jobs/route-helpers";
import { enqueueBuildTraceTurnsJob } from "@/lib/ledger/turns/queries";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { createTokenBucketRateLimiter } from "@/lib/platform/rate-limit";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { enqueueClusterIntentsJob } from "@/lib/readings/intent-engine/jobs";
import {
  enqueueFoldIntentGraphJob,
  type IntentGraphDb,
  syncIntentGraphLiveFromStatus,
} from "@/lib/readings/intent-graph/queries";

export const runtime = "nodejs";

const runtimeEventsRateLimiter = createTokenBucketRateLimiter({
  limitPerMinute: 120,
  burst: 240,
});

/**
 * POST /api/v1/events: typed, quota-exempt runtime-event ingest. A stored batch kicks the
 * turn-ledger build, the paced intent-graph fold and the paced intent-engine run, then drains
 * them after the response. A runtime's ranking-status report also moves its Cloud graph's
 * live period, inside the ingest transaction.
 */
export const POST = withRequestLog(handlePost);

async function handlePost(request: Request): Promise<Response> {
  return handleRuntimeEventsRequest(request, {
    resolveProjectFromBearer,
    getOrganizationByProjectId,
    insertTraceEvents: (projectId, events, db, options) =>
      insertTraceEvents(projectId, events, db, {
        ...options,
        // The ingest transaction is a full handle; the option's type is the ingest's narrower one.
        syncIntentGraphLive: (id, tx) => syncIntentGraphLiveFromStatus(id, tx as IntentGraphDb),
      }),
    insertTraceEventRejects,
    rateLimiter: runtimeEventsRateLimiter,
    traceTurns: {
      enqueueBuild: (projectId) => enqueueBuildTraceTurnsJob(projectId),
      scheduleProjectDrain,
    },
    enqueueFoldIntentGraphJob: (projectId, _payload, options) =>
      enqueueFoldIntentGraphJob(projectId, undefined, options),
    enqueueClusterIntentsJob: (projectId, _payload, options) =>
      enqueueClusterIntentsJob(projectId, undefined, options),
    scheduleProjectDrain,
    setRequestLogContext,
    trackServerEvent,
  });
}
