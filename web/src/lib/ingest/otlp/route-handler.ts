import { gunzipSync, gzipSync, inflateSync } from "node:zlib";
import type { TraceMeteringPort } from "@/lib/contracts/trace-metering";
import type { RedactedExport } from "@/lib/ingest/geo/redact";
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
import type { OtlpRawCaptureDeps } from "@/lib/ingest/otlp-raw/capture";
import {
  enqueueOtlpBatch,
  type IngestQueueAcceptDeps,
  storedEncoding,
} from "@/lib/ingest/queue/accept";
import type { IntentGraphFoldScheduleDeps } from "@/lib/ingest/trace-events/fold-schedule";
import type { insertTraceEvents as insertTraceEventsFn } from "@/lib/ingest/trace-events/queries";
import type { TraceTurnsIngestDeps } from "@/lib/ingest/trace-events/turns-schedule";
import type { hashApiKey as hashApiKeyFn } from "@/lib/platform/api-keys";
import { authenticateApiKey } from "@/lib/platform/api-keys/authenticate";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import type { isDbConfigured as isDbConfiguredFn } from "@/lib/platform/db/client";
import type { EventQuotaResult, OrgLimitView } from "@/lib/platform/entitlements";
import { readBodyWithCap } from "@/lib/platform/http/read-body-with-cap";
import { getLogger, type LogError, type LogWarn } from "@/lib/platform/logger";
import type { getOrganizationByProjectId as getOrganizationByProjectIdFn } from "@/lib/platform/organizations";
import type {
  findActiveApiKeyByHash as findActiveApiKeyByHashFn,
  touchApiKey as touchApiKeyFn,
} from "@/lib/platform/projects/queries";
import type { setRequestLogContext as setRequestLogContextFn } from "@/lib/platform/request-log";
import { reportServerException } from "@/lib/platform/telemetry";
import type { AgentSpanDedupeDeps } from "./agent-span-dedupe";
import { OtlpDecodeError } from "./decode";
import { type OtlpTransport, otlpSuccessResponse, transportFor } from "./http";
import type { IngestLogDeps } from "./ingest-log";
import {
  type IngestObservabilityDeps,
  type IngestRejectionReason,
  rejectIngestRequest,
  trackAcceptedIngestRequest,
  trackFirstTraceReceived,
} from "./ingest-observability";
import type { PersistSpansContext, PersistSpansDeps } from "./ingest-spans";
import type { normalizeAiSdkSpans } from "./normalize-ai-sdk";
import type { FindRuntimeInvokes } from "./runtime-duplicates";
import type { GenAiLogStore } from "./semconv/gen-ai-log-store";
import { decodeTraceExport, storeTraceExport } from "./traces-export";

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

/** Reject bodies above this size, before decoding. */
export const MAX_BODY_BYTES = 4_000_000;
/** A compressed body may expand to this much, and no further (a small zip bomb stops here). */
export const MAX_INFLATED_BYTES = 4 * MAX_BODY_BYTES;

export type InflateResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "unsupported" | "malformed" | "too_large" };

/** The body as sent, gunzipped or inflated when `Content-Encoding` says so, under {@link MAX_INFLATED_BYTES}. */
export function inflateBody(bytes: Uint8Array, contentEncoding: string | null): InflateResult {
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return { ok: true, bytes };
  if (encoding !== "gzip" && encoding !== "x-gzip" && encoding !== "deflate")
    return { ok: false, reason: "unsupported" };
  try {
    const options = { maxOutputLength: MAX_INFLATED_BYTES };
    const out = encoding === "deflate" ? inflateSync(bytes, options) : gunzipSync(bytes, options);
    return { ok: true, bytes: new Uint8Array(out.buffer, out.byteOffset, out.byteLength) };
  } catch (err) {
    return { ok: false, reason: err instanceof RangeError ? "too_large" : "malformed" };
  }
}
export { MAX_SPANS } from "./traces-export";

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
  /** Where each span comes from (`lib/ingest/geo`); absent, no span is located. */
  locate?: PersistSpansDeps["locate"];
  /** The trace properties (`lib/ingest/properties`); absent, no key is recorded and no value stored. */
  properties?: PersistSpansDeps["properties"];
  /** The same for an export that is queued: what must not be stored, taken out of its body. */
  redact?: (
    projectId: string,
    organization: PersistSpansContext["organization"],
    transport: OtlpTransport,
    body: Uint8Array,
  ) => Promise<RedactedExport | null>;
  /** The raw body store (RC-405); absent, nothing is kept. */
  otlpRawCapture?: OtlpRawCaptureDeps;
  /** The project's own prices (RC-482); absent, the current built-in prices. */
  modelPricing?: PersistSpansDeps["modelPricing"];
  /** Where the Datadog ingest lines go; absent, the app log and the cached project lookup. */
  ingestLog?: IngestLogDeps;
  /** The ingest queue (RTL-314); absent or off, every export is decoded and stored in the request. */
  ingestQueue?: IngestQueueAcceptDeps;
}

export async function handleTracesRequest(
  req: Request,
  deps: TracesHandlerDeps,
): Promise<Response> {
  const logError = deps.logError ?? defaultLogError;
  const startedAt = (deps.now?.() ?? new Date()).getTime();
  // 1. Authenticate via the project API key (no DB needed to reject a missing key).
  const authz = req.headers.get("authorization") ?? "";
  const match = authz.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return rejectTraceRequest(
      json({ error: "Missing or malformed Authorization: Bearer <key>." }, 401),
      "invalid_key",
      startedAt,
      deps,
    );
  }

  const contentType = req.headers.get("content-type") ?? "";
  const transport = transportFor(contentType);
  if (!transport) {
    return rejectTraceRequest(
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

  const declaredLen = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return rejectTraceRequest(
      json({ error: `Request body too large (max ${MAX_BODY_BYTES} bytes).` }, 413),
      "oversized",
      startedAt,
      deps,
    );
  }

  if (!deps.isDbConfigured()) {
    return rejectTraceRequest(
      json({ error: "Ingestion is not available. Database not configured." }, 503),
      "unavailable",
      startedAt,
      deps,
    );
  }

  const auth = await authenticateApiKey(req.headers.get("authorization"), deps.scope, deps);
  if (!auth.ok) {
    return rejectTraceRequest(
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
      return rejectTraceRequest(
        ingestRateLimitedResponse(limit),
        "rate_limited",
        startedAt,
        deps,
        apiKey.projectId,
      );
    }
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
      return rejectTraceRequest(
        json({ error: quota.message }, 429),
        "quota",
        startedAt,
        deps,
        apiKey.projectId,
        organization.id,
      );
    }
  }

  // 2. Read + decode the OTLP body, streaming under the byte cap so a chunked
  // request can never buffer past it.
  const read = await readBodyWithCap(req, MAX_BODY_BYTES);
  if (!read.ok) {
    return rejectTraceRequest(
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
    return rejectTraceRequest(
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

  // The ingest queue (RTL-314): keep the body as it arrived and answer; a worker decodes and
  // persists it. An ingest-only key stays inline: its budget counts decoded spans. So does a batch
  // whose address cannot be taken out: the queue stores the body.
  let queueable = deps.ingestQueue?.enabled() && !auth.policy.sharedKeyLimits;
  let redacted: RedactedExport | null = null;
  if (queueable && deps.redact) {
    try {
      redacted = await deps.redact(apiKey.projectId, organization, transport, bytes);
    } catch (err) {
      queueable = false;
      if (!(err instanceof OtlpDecodeError)) {
        logError("span location failed", err, { project_id: apiKey.projectId });
        captureProcessingFailure(err, apiKey.projectId, deps);
      }
    }
  }
  if (queueable && deps.ingestQueue) {
    const contentEncoding = req.headers.get("content-encoding");
    // Compressed when it came compressed.
    const gzip = redacted !== null && storedEncoding(contentEncoding) !== null;
    const queued = await enqueueOtlpBatch(
      {
        projectId: apiKey.projectId,
        signal: "traces",
        transport,
        received: redacted ? (gzip ? gzipSync(redacted.body) : redacted.body) : read.bytes,
        contentEncoding: gzip ? "gzip" : contentEncoding,
        appendOnly: auth.policy.appendOnlyIngest,
        ...(redacted ? { geo: { addressed: redacted.addressed } } : {}),
      },
      deps.ingestQueue,
      { logError, captureFailure: (err) => captureProcessingFailure(err, apiKey.projectId, deps) },
    );
    if (!queued.ok) {
      return rejectTraceRequest(
        json({ error: "Failed to store telemetry." }, 500),
        "storage",
        startedAt,
        deps,
        apiKey.projectId,
        organization?.id,
      );
    }
    await finishAcceptedTraces(apiKey, organization?.id, { queued: 1 }, startedAt, deps);
    return otlpSuccessResponse(transport, { queued: 1 });
  }

  const decoded = decodeTraceExport(transport, bytes);
  if (!decoded.ok) {
    return rejectTraceRequest(
      json({ error: decoded.error }, decoded.status),
      decoded.reason,
      startedAt,
      deps,
      apiKey.projectId,
      organization?.id,
    );
  }
  const spans = decoded.spans;

  // An ingest-only key's budget counts spans too, not only requests (RC-585).
  if (auth.policy.sharedKeyLimits) {
    const items = (deps.publishableLimits ?? publishableIngestLimits).chargeItems(
      req,
      apiKey,
      spans.length,
    );
    if (!items.allowed) {
      return rejectTraceRequest(
        ingestRateLimitedResponse(items),
        "rate_limited",
        startedAt,
        deps,
        apiKey.projectId,
        organization?.id,
      );
    }
  }

  // 3. Normalize, group, persist: shared with the Agent health importer and the ingest queue.
  const stored = await storeTraceExport(
    spans,
    {
      projectId: apiKey.projectId,
      organization,
      quotaOrgId,
      meterTraces,
      transport,
      body: bytes,
      gzipped: isGzipEncoding(req.headers.get("content-encoding")) ? read.bytes : undefined,
    },
    deps,
    {
      logError,
      logWarn: deps.logWarn ?? defaultLogWarn,
      captureFailure: (err) => captureProcessingFailure(err, apiKey.projectId, deps),
    },
  );
  if (!stored.ok && stored.stage === "refused") {
    return rejectTraceRequest(
      json({ error: "Span limit reached for this trace or this billing period." }, 429),
      "quota",
      startedAt,
      deps,
      apiKey.projectId,
      organization?.id,
    );
  }
  if (!stored.ok) {
    return rejectTraceRequest(
      json({ error: "Failed to store telemetry." }, 500),
      "storage",
      startedAt,
      deps,
      apiKey.projectId,
      organization?.id,
    );
  }
  const { accepted, calls } = stored;
  await finishAcceptedTraces(
    apiKey,
    organization?.id,
    { accepted, calls, spans: spans.length },
    startedAt,
    deps,
  );

  return otlpSuccessResponse(transport, {
    accepted,
    calls,
    spans: spans.length,
    ...(stored.refused ? { refused: stored.refused } : {}),
  });
}

/** After an accepted export, stored or queued: the key's heartbeat and the accepted-request events. */
async function finishAcceptedTraces(
  apiKey: { id: string; projectId: string; lastUsedAt: Date | null },
  organizationId: string | undefined,
  counts: Record<string, number>,
  startedAt: number,
  deps: TracesHandlerDeps,
): Promise<void> {
  // Best-effort heartbeat; must never turn a successful insert into a 500.
  await deps.touchApiKey(apiKey.id).catch(() => {});
  if (apiKey.lastUsedAt === null) {
    await trackFirstTraceReceived({
      endpoint: "/v1/traces",
      projectId: apiKey.projectId,
      organizationId,
      startedAt,
      deps,
    });
  }
  await trackAcceptedIngestRequest(counts, {
    endpoint: "/v1/traces",
    projectId: apiKey.projectId,
    organizationId,
    startedAt,
    deps,
  });
}

export function isGzipEncoding(contentEncoding: string | null): boolean {
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  return encoding === "gzip" || encoding === "x-gzip";
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

async function rejectTraceRequest(
  response: Response,
  reason: IngestRejectionReason,
  startedAt: number,
  deps: TracesHandlerDeps,
  projectId?: string,
  organizationId?: string,
): Promise<Response> {
  return rejectIngestRequest(response, reason, {
    endpoint: "/v1/traces",
    startedAt,
    deps,
    projectId,
    organizationId,
  });
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
