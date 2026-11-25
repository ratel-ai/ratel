import {
  ingestRateLimitedResponse,
  type PublishableIngestLimits,
  publishableIngestLimits,
} from "@/lib/ingest/ingest-limits";
import type { IngestLogDeps } from "@/lib/ingest/otlp/ingest-log";
import type { insertOtelLogs as insertOtelLogsFn } from "@/lib/ingest/otlp/queries";
import { inflateBody, isGzipEncoding, MAX_INFLATED_BYTES } from "@/lib/ingest/otlp/route-handler";
import type { GenAiLogJoinDeps } from "@/lib/ingest/otlp/semconv/gen-ai-log-join";
import type { OtlpRawCaptureDeps } from "@/lib/ingest/otlp-raw/capture";
import { enqueueOtlpBatch, type IngestQueueAcceptDeps } from "@/lib/ingest/queue/accept";
import type { hashApiKey as hashApiKeyFn } from "@/lib/platform/api-keys";
import { authenticateApiKey } from "@/lib/platform/api-keys/authenticate";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import type { isDbConfigured as isDbConfiguredFn } from "@/lib/platform/db/client";
import { readBodyWithCap } from "@/lib/platform/http/read-body-with-cap";
import { getLogger, type LogError, type LogWarn } from "@/lib/platform/logger";
import type { getOrganizationByProjectId as getOrganizationByProjectIdFn } from "@/lib/platform/organizations";
import type {
  findActiveApiKeyByHash as findActiveApiKeyByHashFn,
  touchApiKey as touchApiKeyFn,
} from "@/lib/platform/projects/queries";
import type { setRequestLogContext as setRequestLogContextFn } from "@/lib/platform/request-log";
import { reportServerException } from "@/lib/platform/telemetry";
import { otlpSuccessResponse, transportFor } from "./http";
import {
  type IngestObservabilityDeps,
  type IngestRejectionReason,
  rejectIngestRequest,
  trackAcceptedIngestRequest,
} from "./ingest-observability";
import { decodeLogExport, storeLogExport } from "./logs-export";

export const MAX_BODY_BYTES = 4_000_000;
export { MAX_LOG_RECORDS } from "./logs-export";

const logger = getLogger("otlp/logs");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);
const defaultLogWarn: LogWarn = (message, fields) => logger.warn(fields, message);

export interface LogsHandlerDeps extends IngestObservabilityDeps {
  isDbConfigured: typeof isDbConfiguredFn;
  hashApiKey: typeof hashApiKeyFn;
  findActiveApiKeyByHash: typeof findActiveApiKeyByHashFn;
  touchApiKey: typeof touchApiKeyFn;
  /** The scope this route needs (`BEARER_ROUTE_SCOPES`). */
  scope: ApiKeyScope;
  /** Shared-key abuse limits for ingest-only keys; the process-wide budget when absent. */
  publishableLimits?: PublishableIngestLimits;
  insertOtelLogs: typeof insertOtelLogsFn;
  reportServerException?: typeof reportServerException;
  // Resolved for request-log context and analytics; retained log records are
  // quota-free telemetry, so no monthly-cap deps are wired in.
  getOrganizationByProjectId?: typeof getOrganizationByProjectIdFn;
  /** Stamp project/org onto this request's request log line; no-op when absent. */
  setRequestLogContext?: typeof setRequestLogContextFn;
  /** The raw body store (RC-405); absent, nothing is kept. */
  otlpRawCapture?: OtlpRawCaptureDeps;
  /** Restate a stored model call with its new `gen_ai` logs; absent, off. */
  genAiLogJoin?: GenAiLogJoinDeps;
  /** Where the Datadog ingest line goes; absent, the app log and the cached project lookup. */
  ingestLog?: IngestLogDeps;
  /** The ingest queue (RTL-314); absent or off, every export is decoded and stored in the request. */
  ingestQueue?: IngestQueueAcceptDeps;
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

  const auth = await authenticateApiKey(req.headers.get("authorization"), deps.scope, deps);
  if (!auth.ok) {
    return rejectLogsRequest(
      json(
        auth.reason === "forbidden"
          ? {
              error: "forbidden",
              reason: "missing_scope",
              scope: deps.scope,
              message: auth.message,
            }
          : { error: auth.message },
        auth.status,
      ),
      auth.reason === "forbidden"
        ? "missing_scope"
        : auth.reason === "unavailable"
          ? "unavailable"
          : "invalid_key",
      startedAt,
      deps,
    );
  }
  const apiKey = auth.apiKey;
  if (auth.policy.sharedKeyLimits) {
    const limit = (deps.publishableLimits ?? publishableIngestLimits).check(req, apiKey);
    if (!limit.allowed) {
      return rejectLogsRequest(
        ingestRateLimitedResponse(limit),
        "rate_limited",
        startedAt,
        deps,
        apiKey.projectId,
      );
    }
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

  // The OpenTelemetry Collector's otlphttp exporter gzips by default.
  const inflated = inflateBody(read.bytes, req.headers.get("content-encoding"));
  if (!inflated.ok) {
    return rejectLogsRequest(
      inflated.reason === "too_large"
        ? json({ error: `Decompressed body too large (max ${MAX_INFLATED_BYTES} bytes).` }, 413)
        : inflated.reason === "unsupported"
          ? json(
              {
                error:
                  "Unsupported Content-Encoding. Send OTLP uncompressed, or with gzip or deflate.",
              },
              415,
            )
          : json({ error: "Malformed compressed body." }, 400),
      inflated.reason === "too_large" ? "oversized" : "malformed",
      startedAt,
      deps,
      apiKey.projectId,
      organization?.id,
    );
  }
  const bytes = inflated.bytes;

  // The ingest queue (RTL-314): keep the body and answer; a worker decodes and stores it. An
  // ingest-only key stays inline: its budget counts decoded records.
  if (deps.ingestQueue?.enabled() && !auth.policy.sharedKeyLimits) {
    const queued = await enqueueOtlpBatch(
      {
        projectId: apiKey.projectId,
        signal: "logs",
        transport,
        received: read.bytes,
        contentEncoding: req.headers.get("content-encoding"),
        appendOnly: auth.policy.appendOnlyIngest,
      },
      deps.ingestQueue,
      { logError, captureFailure: (error) => captureInsertFailure(error, apiKey.projectId, deps) },
    );
    if (!queued.ok) {
      return rejectLogsRequest(
        json({ error: "Failed to store telemetry." }, 500),
        "storage",
        startedAt,
        deps,
        apiKey.projectId,
        organization?.id,
      );
    }
    await deps.touchApiKey(apiKey.id).catch(() => {});
    await trackAcceptedLogs({ queued: 1 }, apiKey.projectId, organization?.id, startedAt, deps);
    return otlpSuccessResponse(transport, { queued: 1 });
  }

  const decoded = decodeLogExport(transport, bytes);
  if (!decoded.ok) {
    return rejectLogsRequest(
      json({ error: decoded.error }, decoded.status),
      decoded.reason,
      startedAt,
      deps,
      apiKey.projectId,
      organization?.id,
    );
  }
  const records = decoded.records;

  // An ingest-only key's budget counts log records too, not only requests (RC-585).
  if (auth.policy.sharedKeyLimits) {
    const items = (deps.publishableLimits ?? publishableIngestLimits).chargeItems(
      req,
      apiKey,
      records.length,
    );
    if (!items.allowed) {
      return rejectLogsRequest(
        ingestRateLimitedResponse(items),
        "rate_limited",
        startedAt,
        deps,
        apiKey.projectId,
        organization?.id,
      );
    }
  }

  // An append-only key (RC-590) stores its records as logs, but they never
  // rewrite the project's runtime catalog definitions or restate a stored call.
  const stored = await storeLogExport(
    records,
    {
      projectId: apiKey.projectId,
      organization,
      appendOnly: auth.policy.appendOnlyIngest,
      transport,
      body: bytes,
      gzipped: isGzipEncoding(req.headers.get("content-encoding")) ? read.bytes : undefined,
    },
    deps,
    {
      logError,
      logWarn: deps.logWarn ?? defaultLogWarn,
      captureFailure: (error) => captureInsertFailure(error, apiKey.projectId, deps),
    },
  );
  if (!stored.ok) {
    return rejectLogsRequest(
      json({ error: "Failed to store telemetry." }, 500),
      "storage",
      startedAt,
      deps,
      apiKey.projectId,
      organization?.id,
    );
  }
  const { accepted, dropped } = stored;

  await deps.touchApiKey(apiKey.id).catch(() => {});
  await trackAcceptedLogs(
    { accepted, records: records.length, dropped },
    apiKey.projectId,
    organization?.id,
    startedAt,
    deps,
  );

  return otlpSuccessResponse(transport, {
    accepted,
    records: records.length,
    dropped,
  });
}

async function trackAcceptedLogs(
  counts: Record<string, number>,
  projectId: string,
  organizationId: string | undefined,
  startedAt: number,
  deps: LogsHandlerDeps,
): Promise<void> {
  await trackAcceptedIngestRequest(counts, {
    endpoint: "/v1/logs",
    projectId,
    organizationId,
    startedAt,
    deps,
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
