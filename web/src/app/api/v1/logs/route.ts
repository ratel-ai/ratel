import { loadPriceOverrides } from "@/lib/ingest/model-pricing/store";
import { handleLogsRequest } from "@/lib/ingest/otlp/logs-route-handler";
import { insertOtelLogs } from "@/lib/ingest/otlp/queries";
import { createGenAiLogStore } from "@/lib/ingest/otlp/semconv/gen-ai-log-store";
import { createOtlpRawStore } from "@/lib/ingest/otlp-raw/store";
import { ingestAccept } from "@/lib/ingest/queue/ingest-queue";
import { hashApiKey } from "@/lib/platform/api-keys";
import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { getDb, isDbConfigured } from "@/lib/platform/db/client";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { findActiveApiKeyByHash, touchApiKey } from "@/lib/platform/projects/queries";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { trackServerEvent } from "@/lib/platform/telemetry";

export const runtime = "nodejs";

/** POST /api/v1/logs — API-key-authenticated OTLP log ingest. */
export const POST = withRequestLog(handlePost);

async function handlePost(req: Request) {
  return handleLogsRequest(req, {
    scope: BEARER_ROUTE_SCOPES["POST /api/v1/logs"],
    isDbConfigured,
    hashApiKey,
    findActiveApiKeyByHash,
    touchApiKey,
    insertOtelLogs,
    trackServerEvent,
    getOrganizationByProjectId,
    setRequestLogContext,
    otlpRawCapture: { store: createOtlpRawStore() },
    genAiLogJoin: {
      store: createGenAiLogStore(),
      // As span ingest reads them: a restated call keeps the project's prices (RC-482).
      modelPricing: {
        loadOverrides: (projectId) => loadPriceOverrides(projectId, getDb()),
      },
    },
    // With INGEST_QUEUE set, the request is only accepted (ADR-0009). Undefined in direct mode.
    accept: await ingestAccept(),
  });
}
