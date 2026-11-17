import { handleLogsRequest } from "@/lib/ingest/otlp/logs-route-handler";
import { insertOtelLogs } from "@/lib/ingest/otlp/queries";
import { createGenAiLogStore } from "@/lib/ingest/otlp/semconv/gen-ai-log-store";
import { sessionChatCaptureEnabled } from "@/lib/ingest/otlp/session-chat-capture";
import { otlpRawCaptureEnabled } from "@/lib/ingest/otlp-raw/flag";
import { createOtlpRawStore } from "@/lib/ingest/otlp-raw/store";
import { hashApiKey } from "@/lib/platform/api-keys";
import { isDbConfigured } from "@/lib/platform/db/client";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
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
    otlpRawCapture: {
      isEnabled: (projectId, organization) => otlpRawCaptureEnabled(projectId, organization),
      store: createOtlpRawStore(),
    },
    genAiLogJoin: {
      store: createGenAiLogStore(),
      sessionChatCapture: (projectId, organization) =>
        sessionChatCaptureEnabled(projectId, organization),
    },
  });
}
