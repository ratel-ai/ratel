import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { createTokenBucketRateLimiter } from "@/lib/platform/rate-limit";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { handleIntentGraphGet } from "@/lib/readings/intent-graph/get-handler";
import { handleIntentGraphPut } from "@/lib/readings/intent-graph/put-handler";
import {
  getIntentGraph,
  putIntentGraph,
  touchIntentGraphPull,
} from "@/lib/readings/intent-graph/queries";

export const runtime = "nodejs";

// One bucket per API key shared by GET and PUT: the limit is per client, not per
// verb. Sized for several runtime sources behind one key saving on the SDK's
// debounced cadence (15s debounce, 60s max wait), not for a hot loop: every PUT
// rebuilds the cluster/edge projection in a transaction.
const intentGraphRateLimiter = createTokenBucketRateLimiter({
  limitPerMinute: 60,
  burst: 120,
});

/** PUT /api/v1/intent-graph — store a runtime source's adaptive-ranking intent graph. */
export const PUT = withRequestLog((request: Request) =>
  handleIntentGraphPut(request, {
    resolveProjectFromBearer,
    getOrganizationByProjectId,
    putIntentGraph,
    rateLimiter: intentGraphRateLimiter,
    setRequestLogContext,
    trackServerEvent,
  }),
);

/** GET /api/v1/intent-graph?source= — return the stored graph with conditional GET. */
export const GET = withRequestLog((request: Request) =>
  handleIntentGraphGet(request, {
    resolveProjectFromBearer,
    getOrganizationByProjectId,
    getIntentGraph,
    touchIntentGraphPull,
    rateLimiter: intentGraphRateLimiter,
    setRequestLogContext,
    trackServerEvent,
  }),
);
