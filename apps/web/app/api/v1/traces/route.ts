import { insertEventsWithMetrics, insertOtelSpans } from "@/lib/ingest/otlp/queries";
import { handleTracesRequest } from "@/lib/ingest/otlp/route-handler";
import { insertTraceEvents } from "@/lib/ingest/trace-events/queries";
import { hashApiKey } from "@/lib/platform/api-keys";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { findActiveApiKeyByHash, touchApiKey } from "@/lib/platform/projects/queries";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { trackServerEvent } from "@/lib/platform/telemetry";

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
 * The turn-ledger kick, agent-span dedupe and the monthly event counter are
 * wired once those modules land.
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
    setRequestLogContext,
  });
}
