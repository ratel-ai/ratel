import {
  findTracesWithModelCalls,
  insertEventsWithMetrics,
  insertOtelSpans,
} from "@/lib/ingest/otlp/queries";
import { handleTracesRequest } from "@/lib/ingest/otlp/route-handler";
import { findRuntimeInvokes } from "@/lib/ingest/otlp/runtime-facts-query";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { scheduleProjectDrain } from "@/lib/jobs/route-helpers";
import { enqueueBuildTraceTurnsJob } from "@/lib/ledger/turns/queries";
import { hashApiKey } from "@/lib/platform/api-keys";
import { isDbConfigured } from "@/lib/platform/db/client";
import { checkEventQuota, incrementEventUsage } from "@/lib/platform/entitlements";
import { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { findActiveApiKeyByHash, touchApiKey } from "@/lib/platform/projects/queries";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { trackServerEvent } from "@/lib/platform/telemetry";
import { enqueueClusterIntentsJob } from "@/lib/readings/intent-engine/jobs";
import { enqueueFoldIntentGraphJob } from "@/lib/readings/intent-graph/queries";

// OTLP protobuf decode (protobufjs) + node:crypto (key hashing + dedup) — keep off
// the edge runtime.
export const runtime = "nodejs";

/**
 * POST /api/v1/traces — OTLP trace ingest. Accepts a stock
 * `ExportTraceServiceRequest` (application/x-protobuf or application/json) from any
 * OTel exporter, maps the `gen_ai.*` / `ratel.*` spans onto the same
 * events / event_metrics tables the dashboard reads, taps normalized rows into
 * `otel_spans`, and returns 202.
 *
 * The request logic lives in `handleTracesRequest` with its dependencies injected so
 * it is unit-testable without a database; here we wire in the real ones. The monthly
 * event cap goes through the entitlements port (a no-op in the open-source edition).
 * A batch that stored trace events kicks the turn-ledger build, the paced intent-graph
 * fold and the paced intent-engine run, drained after the response.
 */
export const POST = withRequestLog(handlePost);

async function handlePost(req: Request) {
  return handleTracesRequest(req, {
    isDbConfigured,
    hashApiKey,
    findActiveApiKeyByHash,
    touchApiKey,
    insertEventsWithMetrics,
    insertOtelSpans,
    insertTraceEvents,
    trackServerEvent,
    getOrganizationByProjectId,
    checkEventQuota,
    incrementEventUsage,
    setRequestLogContext,
    // Agent health: the host's own tool-call spans as ledger invocations, built after the response.
    traceTurns: {
      enqueueBuild: (projectId) => enqueueBuildTraceTurnsJob(projectId),
      scheduleProjectDrain,
    },
    enqueueFoldIntentGraphJob: (projectId, _payload, options) =>
      enqueueFoldIntentGraphJob(projectId, undefined, options),
    enqueueClusterIntentsJob: (projectId, _payload, options) =>
      enqueueClusterIntentsJob(projectId, undefined, options),
    scheduleProjectDrain,
    findRuntimeInvokes: (projectId, probe) => findRuntimeInvokes(projectId, probe),
    // Agent wrapper spans with summed usage are not counted as model calls.
    agentSpanDedupe: {
      findTracesWithModelCalls: (projectId, traceIds) =>
        findTracesWithModelCalls(projectId, traceIds),
    },
  });
}
