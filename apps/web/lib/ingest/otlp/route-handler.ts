import { gunzipSync, inflateSync } from "node:zlib";
import type {
  insertEventsWithMetrics as insertEventsWithMetricsFn,
  insertOtelSpans as insertOtelSpansFn,
} from "@/lib/ingest/otlp/queries";
import type { IntentGraphFoldScheduleDeps } from "@/lib/ingest/trace-events/fold-schedule";
import type { insertTraceEvents as insertTraceEventsFn } from "@/lib/ingest/trace-events/queries";
import type { TraceTurnsIngestDeps } from "@/lib/ingest/trace-events/turns-schedule";
import type { hashApiKey as hashApiKeyFn } from "@/lib/platform/api-keys";
import type { isDbConfigured as isDbConfiguredFn } from "@/lib/platform/db/client";
import type { EventQuotaResult, OrgLimitView } from "@/lib/platform/entitlements";
import { readBodyWithCap } from "@/lib/platform/http/read-body-with-cap";
import type { getOrganizationByProjectId as getOrganizationByProjectIdFn } from "@/lib/platform/identity/queries";
import { getLogger, type LogError } from "@/lib/platform/logger";
import type {
  findActiveApiKeyByHash as findActiveApiKeyByHashFn,
  touchApiKey as touchApiKeyFn,
} from "@/lib/platform/projects/queries";
import type { setRequestLogContext as setRequestLogContextFn } from "@/lib/platform/request-log";
import { reportServerException } from "@/lib/platform/telemetry";
import type { AgentSpanDedupeDeps } from "./agent-span-dedupe";
import { decodeOtlp, OtlpDecodeError } from "./decode";
import { otlpSuccessResponse, transportFor } from "./http";
import {
  type IngestObservabilityDeps,
  type IngestRejectionReason,
  rejectIngestRequest,
  trackAcceptedIngestRequest,
  trackFirstTraceReceived,
} from "./ingest-observability";
import { persistDecodedSpans } from "./ingest-spans";
import type { normalizeAiSdkSpans } from "./normalize-ai-sdk";
import type { FindRuntimeInvokes } from "./runtime-duplicates";

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
/** Cap spans decoded from one export so a giant batch can't stall the request. */
export const MAX_SPANS = 5_000;
const logger = getLogger("otlp/traces");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);

export interface TracesHandlerDeps extends IngestObservabilityDeps, IntentGraphFoldScheduleDeps {
  isDbConfigured: typeof isDbConfiguredFn;
  hashApiKey: typeof hashApiKeyFn;
  findActiveApiKeyByHash: typeof findActiveApiKeyByHashFn;
  touchApiKey: typeof touchApiKeyFn;
  insertEventsWithMetrics: typeof insertEventsWithMetricsFn;
  insertTraceEvents: typeof insertTraceEventsFn;
  insertOtelSpans: typeof insertOtelSpansFn;
  // Optional monthly-event-cap enforcement, wired by the route; unit tests omit these deps.
  getOrganizationByProjectId?: typeof getOrganizationByProjectIdFn;
  checkEventQuota?: CheckEventQuota;
  incrementEventUsage?: IncrementEventUsage;
  reportServerException?: ReportServerException;
  normalizeAiSdkSpans?: typeof normalizeAiSdkSpans;
  /** Stamp project/org onto this request's request log line; no-op when absent. */
  setRequestLogContext?: typeof setRequestLogContextFn;
  /** Agent health: enqueue and drain for the turn ledger. Absent, tool
   * spans are not bridged into it (unit tests that don't exercise it omit it). */
  traceTurns?: TraceTurnsIngestDeps;
  /** The project's SDK invokes near a batch's tool spans, so a call both send is counted once. */
  findRuntimeInvokes?: FindRuntimeInvokes;
  /** Storage lookup for agent-wrapper span dedupe; absent, off. */
  agentSpanDedupe?: AgentSpanDedupeDeps;
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

  const apiKey = await deps.findActiveApiKeyByHash(deps.hashApiKey(match[1].trim()));
  if (!apiKey) {
    return rejectTraceRequest(
      json({ error: "Invalid or revoked API key." }, 401),
      "invalid_key",
      startedAt,
      deps,
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
  let quotaOrgId: string | undefined;
  if (organization && deps.checkEventQuota) {
    quotaOrgId = organization.id;
    const quota = await deps.checkEventQuota(organization);
    if (!quota.ok) {
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

  let spans: ReturnType<typeof decodeOtlp>;
  try {
    spans = decodeOtlp(transport === "json" ? "application/json" : "application/x-protobuf", bytes);
  } catch (err) {
    if (err instanceof OtlpDecodeError) {
      return rejectTraceRequest(
        json({ error: `Malformed OTLP payload: ${err.message}` }, 400),
        "malformed",
        startedAt,
        deps,
        apiKey.projectId,
        organization?.id,
      );
    }
    throw err;
  }

  if (spans.length > MAX_SPANS) {
    return rejectTraceRequest(
      json({ error: `Too many spans in one export (max ${MAX_SPANS}).` }, 413),
      "oversized",
      startedAt,
      deps,
      apiKey.projectId,
      organization?.id,
    );
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
    },
    {
      ...deps,
      logError,
      captureFailure: (err) => captureProcessingFailure(err, apiKey.projectId, deps),
    },
  );
  if (!persisted.ok) {
    return rejectTraceRequest(
      json({ error: "Failed to store telemetry." }, 500),
      "storage",
      startedAt,
      deps,
      apiKey.projectId,
      organization?.id,
    );
  }
  const { accepted, calls } = persisted;

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
  });
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
