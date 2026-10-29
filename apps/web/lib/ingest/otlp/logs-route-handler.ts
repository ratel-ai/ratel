import type { insertOtelLogs as insertOtelLogsFn } from "@/lib/ingest/otlp/queries";
import type { hashApiKey as hashApiKeyFn } from "@/lib/platform/api-keys";
import type { isDbConfigured as isDbConfiguredFn } from "@/lib/platform/db/client";
import { readBodyWithCap } from "@/lib/platform/http/read-body-with-cap";
import type { getOrganizationByProjectId as getOrganizationByProjectIdFn } from "@/lib/platform/identity/queries";
import { getLogger, type LogError } from "@/lib/platform/logger";
import type {
  findActiveApiKeyByHash as findActiveApiKeyByHashFn,
  touchApiKey as touchApiKeyFn,
} from "@/lib/platform/projects/queries";
import type { setRequestLogContext as setRequestLogContextFn } from "@/lib/platform/request-log";
import { reportServerException } from "@/lib/platform/telemetry";
import { decodeOtlpLogs, OtlpDecodeError } from "./decode-logs";
import { otlpSuccessResponse, transportFor } from "./http";
import {
  type IngestObservabilityDeps,
  type IngestRejectionReason,
  rejectIngestRequest,
  trackAcceptedIngestRequest,
} from "./ingest-observability";
import { toOtelLogRows } from "./log-rows";

export const MAX_BODY_BYTES = 4_000_000;
export const MAX_LOG_RECORDS = 5_000;
const logger = getLogger("otlp/logs");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);

export interface LogsHandlerDeps extends IngestObservabilityDeps {
  isDbConfigured: typeof isDbConfiguredFn;
  hashApiKey: typeof hashApiKeyFn;
  findActiveApiKeyByHash: typeof findActiveApiKeyByHashFn;
  touchApiKey: typeof touchApiKeyFn;
  insertOtelLogs: typeof insertOtelLogsFn;
  reportServerException?: typeof reportServerException;
  // Resolved for request-log context and analytics; retained log records are
  // quota-free telemetry, so no monthly-cap deps are wired in.
  getOrganizationByProjectId?: typeof getOrganizationByProjectIdFn;
  /** Stamp project/org onto this request's request log line; no-op when absent. */
  setRequestLogContext?: typeof setRequestLogContextFn;
}

export async function handleLogsRequest(req: Request, deps: LogsHandlerDeps): Promise<Response> {
  const logError = deps.logError ?? defaultLogError;
  const startedAt = (deps.now?.() ?? new Date()).getTime();
  const authorization = req.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return rejectLogsRequest(
      json({ error: "Missing or malformed Authorization: Bearer <key>." }, 401),
      "invalid_key",
      startedAt,
      deps,
    );
  }

  const transport = transportFor(req.headers.get("content-type") ?? "");
  if (!transport) {
    return rejectLogsRequest(
      json(
        {
          error:
            "Unsupported Content-Type. Send OTLP as application/x-protobuf or application/json.",
        },
        415,
      ),
      "unsupported_media",
      startedAt,
      deps,
    );
  }

  const declaredLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return rejectLogsRequest(
      json({ error: `Request body too large (max ${MAX_BODY_BYTES} bytes).` }, 413),
      "oversized",
      startedAt,
      deps,
    );
  }

  if (!deps.isDbConfigured()) {
    return rejectLogsRequest(
      json({ error: "Ingestion is not available. Database not configured." }, 503),
      "unavailable",
      startedAt,
      deps,
    );
  }

  const apiKey = await deps.findActiveApiKeyByHash(deps.hashApiKey(match[1].trim()));
  if (!apiKey) {
    return rejectLogsRequest(
      json({ error: "Invalid or revoked API key." }, 401),
      "invalid_key",
      startedAt,
      deps,
    );
  }

  // Resolve the org for request-log context. Unlike /v1/traces, retained log
  // records are quota-free telemetry — the raw-span-tap sibling, and per-plan
  // telemetry quotas remain deferred — so there is no monthly-cap gate here.
  const organization = deps.getOrganizationByProjectId
    ? await deps.getOrganizationByProjectId(apiKey.projectId)
    : null;
  deps.setRequestLogContext?.(req, {
    project_id: apiKey.projectId,
    ...(organization ? { org_id: organization.id } : {}),
  });
  // Stream under the byte cap so a chunked request can never buffer past it.
  const read = await readBodyWithCap(req, MAX_BODY_BYTES);
  if (!read.ok) {
    return rejectLogsRequest(
      json({ error: `Request body too large (max ${MAX_BODY_BYTES} bytes).` }, 413),
      "oversized",
      startedAt,
      deps,
      apiKey.projectId,
      organization?.id,
    );
  }

  let records: ReturnType<typeof decodeOtlpLogs>;
  try {
    records = decodeOtlpLogs(
      transport === "json" ? "application/json" : "application/x-protobuf",
      read.bytes,
    );
  } catch (error) {
    if (error instanceof OtlpDecodeError) {
      return rejectLogsRequest(
        json({ error: `Malformed OTLP payload: ${error.message}` }, 400),
        "malformed",
        startedAt,
        deps,
        apiKey.projectId,
        organization?.id,
      );
    }
    throw error;
  }

  if (records.length > MAX_LOG_RECORDS) {
    return rejectLogsRequest(
      json({ error: `Too many log records in one export (max ${MAX_LOG_RECORDS}).` }, 413),
      "oversized",
      startedAt,
      deps,
      apiKey.projectId,
      organization?.id,
    );
  }

  const { rows, dropped } = toOtelLogRows(apiKey.projectId, records);
  let accepted = 0;
  if (rows.length > 0) {
    try {
      ({ accepted } = await deps.insertOtelLogs(apiKey.projectId, rows));
    } catch (error) {
      logError("log record insert failed", error, { project_id: apiKey.projectId });
      captureInsertFailure(error, apiKey.projectId, deps);
      return rejectLogsRequest(
        json({ error: "Failed to store telemetry." }, 500),
        "storage",
        startedAt,
        deps,
        apiKey.projectId,
        organization?.id,
      );
    }
  }

  await deps.touchApiKey(apiKey.id).catch(() => {});

  await trackAcceptedIngestRequest(
    { accepted, records: records.length, dropped },
    {
      endpoint: "/v1/logs",
      projectId: apiKey.projectId,
      organizationId: organization?.id,
      startedAt,
      deps,
    },
  );

  return otlpSuccessResponse(transport, {
    accepted,
    records: records.length,
    dropped,
  });
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

async function rejectLogsRequest(
  response: Response,
  reason: IngestRejectionReason,
  startedAt: number,
  deps: LogsHandlerDeps,
  projectId?: string,
  organizationId?: string,
): Promise<Response> {
  return rejectIngestRequest(response, reason, {
    endpoint: "/v1/logs",
    startedAt,
    deps,
    projectId,
    organizationId,
  });
}

function captureInsertFailure(error: unknown, projectId: string, deps: LogsHandlerDeps): void {
  try {
    (deps.reportServerException ?? reportServerException)(error, `project:${projectId}`, {
      endpoint: "/v1/logs",
      project_id: projectId,
    });
  } catch (captureError) {
    (deps.logError ?? defaultLogError)("exception capture failed", captureError, {
      project_id: projectId,
    });
  }
}
