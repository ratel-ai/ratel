import { handleLogsRequest } from "@/lib/ingest/otlp/logs-route-handler";
import { insertOtelLogs } from "@/lib/ingest/otlp/queries";
import { hashApiKey } from "@/lib/platform/api-keys";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { findActiveApiKeyByHash, touchApiKey } from "@/lib/platform/projects/queries";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { trackServerEvent } from "@/lib/platform/telemetry";

export const runtime = "nodejs";

/** POST /api/v1/logs — API-key-authenticated OTLP log ingest. */
export const POST = withRequestLog(handlePost);

async function handlePost(req: Request) {
  return handleLogsRequest(req, {
    isDbConfigured,
    hashApiKey,
    findActiveApiKeyByHash,
    touchApiKey,
    insertOtelLogs,
    trackServerEvent,
    getOrganizationByProjectId,
    setRequestLogContext,
  });
}
