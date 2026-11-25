import type { TraceMeteringPort } from "@/lib/contracts/trace-metering";
import {
  ingestRateLimitedResponse,
  type PublishableIngestLimits,
  publishableIngestLimits,
} from "@/lib/ingest/ingest-limits";
import type {
  findStoredOtelSpans as findStoredOtelSpansFn,
  insertEventsWithMetrics as insertEventsWithMetricsFn,
  insertOtelSpans as insertOtelSpansFn,
} from "@/lib/ingest/otlp/queries";
import { captureOtlpRawExport, type OtlpRawCaptureDeps } from "@/lib/ingest/otlp-raw/capture";
import type { AcceptDeps } from "@/lib/ingest/queue/accept";
import { ingestQuotaGate, type QuotaGate } from "@/lib/ingest/queue/quota-gate";
import type { IntentGraphFoldScheduleDeps } from "@/lib/ingest/trace-events/fold-schedule";
import type { insertTraceEvents as insertTraceEventsFn } from "@/lib/ingest/trace-events/queries";
import type { TraceTurnsIngestDeps } from "@/lib/ingest/trace-events/turns-schedule";
import type { hashApiKey as hashApiKeyFn } from "@/lib/platform/api-keys";
import { authenticateApiKey } from "@/lib/platform/api-keys/authenticate";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import type { isDbConfigured as isDbConfiguredFn } from "@/lib/platform/db/client";
import type { EventQuotaResult, OrgLimitView } from "@/lib/platform/entitlements";
import { getLogger, type LogError, type LogWarn } from "@/lib/platform/logger";
import type { getOrganizationByProjectId as getOrganizationByProjectIdFn } from "@/lib/platform/organizations";
import type {
  findActiveApiKeyByHash as findActiveApiKeyByHashFn,
  touchApiKey as touchApiKeyFn,
} from "@/lib/platform/projects/queries";
import type { setRequestLogContext as setRequestLogContextFn } from "@/lib/platform/request-log";
import { reportServerException } from "@/lib/platform/telemetry";
import { acceptOtlpRequest } from "./accept-otlp";
import {
  admitOtlpKey,
  checkOtlpHeaders,
  inflateRefusal,
  otlpRejecter,
  readOtlpBody,
} from "./admit";
import type { AgentSpanDedupeDeps } from "./agent-span-dedupe";
import { inflateBody, isGzipEncoding, MAX_SPANS } from "./body";
import { decodeOtlp, OtlpDecodeError } from "./decode";
import { otlpSuccessResponse } from "./http";
import { type IngestLogDeps, logTracesIngested } from "./ingest-log";
import {
  type IngestObservabilityDeps,
  trackAcceptedIngestRequest,
  trackFirstTraceReceived,
} from "./ingest-observability";
import { type PersistSpansDeps, persistDecodedSpans } from "./ingest-spans";
import type { normalizeAiSdkSpans } from "./normalize-ai-sdk";
import type { FindRuntimeInvokes } from "./runtime-duplicates";
import type { GenAiLogStore } from "./semconv/gen-ai-log-store";

/**
 * The monthly event cap, through the entitlements port: `checkEventQuota` before the
 * write (the counting edition resets an elapsed period and compares), `incrementEventUsage`
 * after it by the events actually stored. Both optional; unit tests omit them.
 */
type CheckEventQuota = (organization: OrgLimitView) => Promise<EventQuotaResult>;
type IncrementEventUsage = (organizationId: string, n: number) => Promise<void>;
type ReportServerException = typeof reportServerException;

/**
 * OTLP trace ingest handler (ADR-0007: "remote telemetry is OpenTelemetry").
 * Mirrors the chats handler — Bearer auth + dependency injection so the contract
 * is unit-testable without a database. Accepts a stock OTLP `ExportTraceServiceRequest`
 * (protobuf or JSON), maps the `gen_ai.*` / `ratel.*` spans onto the same
 * `events` / `event_metrics` tables the dashboard already reads, and taps
 * normalized rows into `otel_spans`.
 */

export {
  type InflateResult,
  inflateBody,
  isGzipEncoding,
  MAX_BODY_BYTES,
  MAX_INFLATED_BYTES,
  MAX_SPANS,
} from "./body";

const logger = getLogger("otlp/traces");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);
const defaultLogWarn: LogWarn = (message, fields) => logger.warn(fields, message);

export interface TracesHandlerDeps extends IngestObservabilityDeps, IntentGraphFoldScheduleDeps {
  isDbConfigured: typeof isDbConfiguredFn;
  hashApiKey: typeof hashApiKeyFn;
  findActiveApiKeyByHash: typeof findActiveApiKeyByHashFn;
  touchApiKey: typeof touchApiKeyFn;
  /** The scope this route needs (`BEARER_ROUTE_SCOPES`). */
  scope: ApiKeyScope;
  /** Shared-key abuse limits for ingest-only keys; the process-wide budget when absent. */
  publishableLimits?: PublishableIngestLimits;
  insertEventsWithMetrics: typeof insertEventsWithMetricsFn;
  insertTraceEvents: typeof insertTraceEventsFn;
  insertOtelSpans: typeof insertOtelSpansFn;
  findStoredOtelSpans?: typeof findStoredOtelSpansFn;
  // Optional monthly-event-cap enforcement, wired by the route; unit tests omit these deps.
  getOrganizationByProjectId?: typeof getOrganizationByProjectIdFn;
  checkEventQuota?: CheckEventQuota;
  incrementEventUsage?: IncrementEventUsage;
  /** The edition's trace meters; absent, or not metering the organization, every trace is analyzed. */
  traceMetering?: TraceMeteringPort;
  reportServerException?: ReportServerException;
  normalizeAiSdkSpans?: typeof normalizeAiSdkSpans;
  /** Stamp project/org onto this request's request log line; no-op when absent. */
  setRequestLogContext?: typeof setRequestLogContextFn;
  /** Agent health: enqueue and drain for the turn ledger. Absent, tool
   * spans are not bridged into it (unit tests that don't exercise it omit it). */
  traceTurns?: TraceTurnsIngestDeps;
  /** The project's SDK invokes near a batch's tool spans, so a call both send is counted once. */
  findRuntimeInvokes?: FindRuntimeInvokes;
  /** The agent-span dedupe's storage lookup: live ingest always dedupes. */
  agentSpanDedupe: AgentSpanDedupeDeps;
  /** Stored `gen_ai` log records join their spans; absent, none are read. */
  genAiLogs?: Pick<GenAiLogStore, "findLogs">;
  /** The raw body store (RC-405); absent, nothing is kept. */
  otlpRawCapture?: OtlpRawCaptureDeps;
  /** The project's own prices (RC-482); absent, the current built-in prices. */
  modelPricing?: PersistSpansDeps["modelPricing"];
  /** Where the Datadog ingest lines go; absent, the app log and the cached project lookup. */
  ingestLog?: IngestLogDeps;
  /** Accept onto the queue (ADR-0009) instead of storing in the request. Absent, direct mode. */
  accept?: AcceptDeps;
  /** The cached answer of the monthly cap for accept; the process-wide one when absent. */
  quotaGate?: QuotaGate;
}

export async function handleTracesRequest(
  req: Request,
  deps: TracesHandlerDeps,
): Promise<Response> {
  const logError = deps.logError ?? defaultLogError;
  const startedAt = (deps.now?.() ?? new Date()).getTime();
  const reject = otlpRejecter("/v1/traces", startedAt, deps);
  // 1. Content type, size, API key and the shared-key limits.
  const headers = checkOtlpHeaders(req, deps);
  if (!headers.ok) return reject(headers.refusal);
  const { transport } = headers;
  const auth = await authenticateApiKey(req.headers.get("authorization"), deps.scope, deps);
  const admission = admitOtlpKey(req, auth, deps);
  if (!admission.ok) return reject(admission.refusal, admission.projectId);
  const { apiKey, policy } = admission;
  if (deps.accept) {
    return acceptOtlpRequest(
      req,
      { signal: "traces", startedAt, reject, transport, admission, maxItems: MAX_SPANS },
      {
        ...deps,
        accept: deps.accept,
        quota: (organizationId) => acceptQuota(organizationId, apiKey.projectId, deps),
      },
    );
  }

  // 1b. Plan cap: reject once the org is over its monthly trace-event allotment. The
  // entitlements port answers; the open-source edition always allows.
  const organization = deps.getOrganizationByProjectId
    ? await deps.getOrganizationByProjectId(apiKey.projectId)
    : null;
  deps.setRequestLogContext?.(req, {
    project_id: apiKey.projectId,
    ...(organization ? { org_id: organization.id } : {}),
  });
  // The event cap does not reject a metered organization: over an allowance its traces are stored
  // ingested-only or dropped. The edition's span bounds do, once the spans are decoded.
  const meterTraces =
    organization && deps.traceMetering
      ? await deps.traceMetering.isMetered({ organization, projectId: apiKey.projectId })
      : false;
  let quotaOrgId: string | undefined;
  if (organization && deps.checkEventQuota) {
    quotaOrgId = organization.id;
    const quota = await deps.checkEventQuota(organization);
    if (!meterTraces && !quota.ok) {
      return reject(
        { response: json({ error: quota.message }, 429), reason: "quota" },
        apiKey.projectId,
        organization.id,
      );
    }
  }

  // 2. Read + decode the OTLP body.
  const read = await readOtlpBody(req);
  if (!read.ok) return reject(read.refusal, apiKey.projectId, organization?.id);
  // The OpenTelemetry Collector's otlphttp exporter gzips by default.
  const inflated = inflateBody(read.bytes, req.headers.get("content-encoding"));
  if (!inflated.ok) return reject(inflateRefusal(inflated), apiKey.projectId, organization?.id);
  const bytes = inflated.bytes;

  let spans: ReturnType<typeof decodeOtlp>;
  try {
    spans = decodeOtlp(transport === "json" ? "application/json" : "application/x-protobuf", bytes);
  } catch (err) {
    if (err instanceof OtlpDecodeError) {
      return reject(
        {
          response: json({ error: `Malformed OTLP payload: ${err.message}` }, 400),
          reason: "malformed",
        },
        apiKey.projectId,
        organization?.id,
      );
    }
    throw err;
  }

  if (spans.length > MAX_SPANS) {
    return reject(
      {
        response: json({ error: `Too many spans in one export (max ${MAX_SPANS}).` }, 413),
        reason: "oversized",
      },
      apiKey.projectId,
      organization?.id,
    );
  }

  // An ingest-only key's budget counts spans too, not only requests (RC-585).
  if (policy.sharedKeyLimits) {
    const items = (deps.publishableLimits ?? publishableIngestLimits).chargeItems(
      req,
      apiKey,
      spans.length,
    );
    if (!items.allowed) {
      return reject(
        { response: ingestRateLimitedResponse(items), reason: "rate_limited" },
        apiKey.projectId,
        organization?.id,
      );
    }
  }

  // 3. Normalize, group, persist: shared with the Agent health importer.
  const persisted = await persistDecodedSpans(
    spans,
    {
      projectId: apiKey.projectId,
      organization,
      quotaOrgId,
      endpoint: "/v1/traces",
      foldIntentGraph: true,
      meterTraces,
    },
    {
      ...deps,
      logError,
      captureFailure: (err) => captureProcessingFailure(err, apiKey.projectId, deps),
    },
  );
  if (!persisted.ok && persisted.stage === "refused") {
    return reject(
      {
        response: json({ error: "Span limit reached for this trace or this billing period." }, 429),
        reason: "quota",
      },
      apiKey.projectId,
      organization?.id,
    );
  }
  if (!persisted.ok) {
    return reject(
      { response: json({ error: "Failed to store telemetry." }, 500), reason: "storage" },
      apiKey.projectId,
      organization?.id,
    );
  }
  const { accepted, calls } = persisted;
  await logTracesIngested(apiKey.projectId, spans, persisted.rows, deps.ingestLog);

  // Raw capture after a stored export, so garbage and retried failures are
  // never kept. Nor is a partly refused one: its body holds the refused spans. Fails open: it never
  // changes the response.
  if (!persisted.refused)
    await captureOtlpRawExport(
      {
        projectId: apiKey.projectId,
        signal: "traces",
        contentType: transport === "json" ? "application/json" : "application/x-protobuf",
        body: bytes,
        gzipped: isGzipEncoding(req.headers.get("content-encoding")) ? read.bytes : undefined,
        itemCount: spans.length,
        traceIds: [...new Set(spans.map((span) => span.traceId))],
      },
      organization,
      deps.otlpRawCapture,
      {
        logError,
        logWarn: deps.logWarn ?? defaultLogWarn,
        captureFailure: (err) => captureProcessingFailure(err, apiKey.projectId, deps),
        trackServerEvent: deps.trackServerEvent,
      },
    );

  // Best-effort heartbeat; must never turn a successful insert into a 500.
  await deps.touchApiKey(apiKey.id).catch(() => {});

  if (apiKey.lastUsedAt === null) {
    await trackFirstTraceReceived({
      endpoint: "/v1/traces",
      projectId: apiKey.projectId,
      organizationId: organization?.id,
      startedAt,
      deps,
    });
  }
  await trackAcceptedIngestRequest(
    { accepted, calls, spans: spans.length },
    {
      endpoint: "/v1/traces",
      projectId: apiKey.projectId,
      organizationId: organization?.id,
      startedAt,
      deps,
    },
  );

  return otlpSuccessResponse(transport, {
    accepted,
    calls,
    spans: spans.length,
    ...(persisted.refused ? { refused: persisted.refused } : {}),
  });
}

/**
 * The monthly event cap as accept asks it. A metered organization is not rejected by it: the trace
 * meter decides when the spans are processed.
 */
function acceptQuota(
  organizationId: string,
  projectId: string,
  deps: TracesHandlerDeps,
): Promise<EventQuotaResult> {
  const { getOrganizationByProjectId, checkEventQuota, traceMetering } = deps;
  return (deps.quotaGate ?? ingestQuotaGate).check(organizationId, async () => {
    const organization = await getOrganizationByProjectId?.(projectId);
    if (!organization || !checkEventQuota) return { ok: true };
    const metered = (await traceMetering?.isMetered({ organization, projectId })) ?? false;
    const quota = await checkEventQuota(organization);
    return metered ? { ok: true } : quota;
  });
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

function captureProcessingFailure(
  error: unknown,
  projectId: string,
  deps: TracesHandlerDeps,
): void {
  try {
    (deps.reportServerException ?? reportServerException)(error, `project:${projectId}`, {
      endpoint: "/v1/traces",
      project_id: projectId,
    });
  } catch (captureError) {
    (deps.logError ?? defaultLogError)("exception capture failed", captureError, {
      project_id: projectId,
    });
  }
}
