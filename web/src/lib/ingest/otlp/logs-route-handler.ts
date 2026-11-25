import {
  ingestRateLimitedResponse,
  type PublishableIngestLimits,
  publishableIngestLimits,
} from "@/lib/ingest/ingest-limits";
import { type IngestLogDeps, logLogsIngested } from "@/lib/ingest/otlp/ingest-log";
import type { insertOtelLogs as insertOtelLogsFn } from "@/lib/ingest/otlp/queries";
import {
  type GenAiLogJoinDeps,
  rejoinStoredModelCalls,
} from "@/lib/ingest/otlp/semconv/gen-ai-log-join";
import { distinctSpanKeys } from "@/lib/ingest/otlp/semconv/gen-ai-logs";
import { captureOtlpRawExport, type OtlpRawCaptureDeps } from "@/lib/ingest/otlp-raw/capture";
import type { hashApiKey as hashApiKeyFn } from "@/lib/platform/api-keys";
import { authenticateApiKey } from "@/lib/platform/api-keys/authenticate";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import type { isDbConfigured as isDbConfiguredFn } from "@/lib/platform/db/client";
import { getLogger, type LogError, type LogWarn } from "@/lib/platform/logger";
import type { getOrganizationByProjectId as getOrganizationByProjectIdFn } from "@/lib/platform/organizations";
import type {
  findActiveApiKeyByHash as findActiveApiKeyByHashFn,
  touchApiKey as touchApiKeyFn,
} from "@/lib/platform/projects/queries";
import type { setRequestLogContext as setRequestLogContextFn } from "@/lib/platform/request-log";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  admitOtlpKey,
  checkOtlpHeaders,
  inflateRefusal,
  otlpRejecter,
  readOtlpBody,
} from "./admit";
import { inflateBody, isGzipEncoding, MAX_LOG_RECORDS } from "./body";
import { decodeOtlpLogs, OtlpDecodeError } from "./decode-logs";
import { otlpSuccessResponse } from "./http";
import { type IngestObservabilityDeps, trackAcceptedIngestRequest } from "./ingest-observability";
import { toOtelLogRows } from "./log-rows";

export { MAX_BODY_BYTES, MAX_LOG_RECORDS } from "./body";

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
}

export async function handleLogsRequest(req: Request, deps: LogsHandlerDeps): Promise<Response> {
  const logError = deps.logError ?? defaultLogError;
  const startedAt = (deps.now?.() ?? new Date()).getTime();
  const reject = otlpRejecter("/v1/logs", startedAt, deps);
  const headers = checkOtlpHeaders(req, deps);
  if (!headers.ok) return reject(headers.refusal);
  const { transport } = headers;
  const auth = await authenticateApiKey(req.headers.get("authorization"), deps.scope, deps);
  const admission = admitOtlpKey(req, auth, deps);
  if (!admission.ok) return reject(admission.refusal, admission.projectId);
  const { apiKey, policy } = admission;

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
  const read = await readOtlpBody(req);
  if (!read.ok) return reject(read.refusal, apiKey.projectId, organization?.id);

  // The OpenTelemetry Collector's otlphttp exporter gzips by default.
  const inflated = inflateBody(read.bytes, req.headers.get("content-encoding"));
  if (!inflated.ok) return reject(inflateRefusal(inflated), apiKey.projectId, organization?.id);
  const bytes = inflated.bytes;

  let records: ReturnType<typeof decodeOtlpLogs>;
  try {
    records = decodeOtlpLogs(
      transport === "json" ? "application/json" : "application/x-protobuf",
      bytes,
    );
  } catch (error) {
    if (error instanceof OtlpDecodeError) {
      return reject(
        {
          response: json({ error: `Malformed OTLP payload: ${error.message}` }, 400),
          reason: "malformed",
        },
        apiKey.projectId,
        organization?.id,
      );
    }
    throw error;
  }

  if (records.length > MAX_LOG_RECORDS) {
    return reject(
      {
        response: json(
          { error: `Too many log records in one export (max ${MAX_LOG_RECORDS}).` },
          413,
        ),
        reason: "oversized",
      },
      apiKey.projectId,
      organization?.id,
    );
  }

  // An ingest-only key's budget counts log records too, not only requests (RC-585).
  if (policy.sharedKeyLimits) {
    const items = (deps.publishableLimits ?? publishableIngestLimits).chargeItems(
      req,
      apiKey,
      records.length,
    );
    if (!items.allowed) {
      return reject(
        { response: ingestRateLimitedResponse(items), reason: "rate_limited" },
        apiKey.projectId,
        organization?.id,
      );
    }
  }

  const { rows, dropped } = toOtelLogRows(apiKey.projectId, records);
  // An append-only key (RC-590) stores its records as logs, but they never
  // rewrite the project's runtime catalog definitions.
  const appendOnly = policy.appendOnlyIngest;
  const stored = appendOnly ? rows.map(({ catalogDefinition: _definition, ...row }) => row) : rows;
  let accepted = 0;
  if (stored.length > 0) {
    try {
      ({ accepted } = await deps.insertOtelLogs(apiKey.projectId, stored));
    } catch (error) {
      logError("log record insert failed", error, { project_id: apiKey.projectId });
      captureInsertFailure(error, apiKey.projectId, deps);
      return reject(
        { response: json({ error: "Failed to store telemetry." }, 500), reason: "storage" },
        apiKey.projectId,
        organization?.id,
      );
    }
  }

  // Spans before logs: restate the model calls these records belong to.
  // Fails open: the logs are stored, and a retry of the export joins again.
  // An append-only key never restates a stored call (RC-590).
  if (deps.genAiLogJoin && !appendOnly) {
    const keys = distinctSpanKeys(rows.filter((row) => row.eventName.startsWith("gen_ai.")));
    try {
      await rejoinStoredModelCalls(apiKey.projectId, organization, keys, {
        ...deps.genAiLogJoin,
        captureFailure: (failure) => captureInsertFailure(failure, apiKey.projectId, deps),
      });
    } catch (error) {
      logError("gen_ai log join failed", error, { project_id: apiKey.projectId });
      captureInsertFailure(error, apiKey.projectId, deps);
    }
  }

  // Raw capture after a stored export; fails open, never changes the response.
  await captureOtlpRawExport(
    {
      projectId: apiKey.projectId,
      signal: "logs",
      contentType: transport === "json" ? "application/json" : "application/x-protobuf",
      body: bytes,
      gzipped: isGzipEncoding(req.headers.get("content-encoding")) ? read.bytes : undefined,
      itemCount: records.length,
      traceIds: [...new Set(records.flatMap((record) => (record.traceId ? [record.traceId] : [])))],
    },
    organization,
    deps.otlpRawCapture,
    {
      logError,
      logWarn: deps.logWarn ?? defaultLogWarn,
      captureFailure: (error) => captureInsertFailure(error, apiKey.projectId, deps),
      trackServerEvent: deps.trackServerEvent,
    },
  );

  await deps.touchApiKey(apiKey.id).catch(() => {});

  await logLogsIngested(
    apiKey.projectId,
    { records: records.length, accepted, dropped },
    deps.ingestLog,
  );
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
