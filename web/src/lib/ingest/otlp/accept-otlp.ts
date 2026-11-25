import { ingestRateLimitedResponse, publishableIngestLimits } from "@/lib/ingest/ingest-limits";
import {
  type AcceptDeps,
  publishRequest,
  queueUnavailableResponse,
} from "@/lib/ingest/queue/accept";
import type { EventQuotaResult } from "@/lib/platform/entitlements";
import type { setRequestLogContext as setRequestLogContextFn } from "@/lib/platform/request-log";
import {
  inflateRefusal,
  type OtlpAdmission,
  type OtlpAdmitDeps,
  type Refusal,
  type RejectOtlp,
  readOtlpBody,
  refusal,
} from "./admit";
import { contentEncodingOf, inflateBody } from "./body";
import { countOtlpItems } from "./count-items";
import { OtlpDecodeError } from "./decode";
import type { OtlpTransport } from "./http";

const ITEM_NAMES = { traces: "spans", logs: "log records" } as const;

export interface OtlpAcceptRequest {
  signal: "traces" | "logs";
  startedAt: number;
  reject: RejectOtlp;
  transport: OtlpTransport;
  admission: Extract<OtlpAdmission, { ok: true }>;
  maxItems: number;
}

export interface OtlpAcceptDeps extends Pick<OtlpAdmitDeps, "publishableLimits"> {
  accept: AcceptDeps;
  /** The monthly event cap; absent, the signal has none. */
  quota?: (organizationId: string) => Promise<EventQuotaResult>;
  setRequestLogContext?: typeof setRequestLogContextFn;
}

/**
 * Accept (ADR-0009) for an admitted OTLP request: publish its body as it came and answer 202. The
 * consumer decodes and stores it.
 */
export async function acceptOtlpRequest(
  req: Request,
  request: OtlpAcceptRequest,
  deps: OtlpAcceptDeps,
): Promise<Response> {
  const { signal, startedAt, reject, transport } = request;
  const { apiKey, policy } = request.admission;
  const { projectId } = apiKey;
  const organizationId = await deps.accept.findOrganizationId(projectId);
  if (!organizationId) {
    // The project was deleted after the key was read, and its keys with it.
    return reject(refusal("invalid_key", 401, "Invalid or revoked API key."), projectId);
  }
  deps.setRequestLogContext?.(req, { project_id: projectId, org_id: organizationId });
  const refuse = (why: Refusal) => reject(why, projectId, organizationId);

  const quota = await deps.quota?.(organizationId);
  if (quota && !quota.ok) return refuse(refusal("quota", 429, quota.message));

  const read = await readOtlpBody(req);
  if (!read.ok) return refuse(read.refusal);
  const contentEncoding = contentEncodingOf(req.headers.get("content-encoding"));
  if (!contentEncoding) return refuse(inflateRefusal({ ok: false, reason: "unsupported" }));

  if (policy.sharedKeyLimits) {
    const over = chargeItems(req, read.bytes, contentEncoding, request, deps);
    if (over) return refuse(over);
  }

  const published = await publishRequest(
    {
      projectId,
      organizationId,
      keyId: apiKey.id,
      policy,
      signal,
      contentType: transport === "json" ? "application/json" : "application/x-protobuf",
      contentEncoding,
      receivedAt: startedAt,
      body: read.bytes,
    },
    deps.accept,
  );
  if (!published) return refuse({ response: queueUnavailableResponse(), reason: "unavailable" });
  return queuedOtlpResponse(transport);
}

/** A shared key ships inside apps, so its item budget must hold before the message is durable. */
function chargeItems(
  req: Request,
  bytes: Uint8Array,
  contentEncoding: string,
  { signal, transport, admission, maxItems }: OtlpAcceptRequest,
  deps: OtlpAcceptDeps,
): Refusal | null {
  const inflated = inflateBody(bytes, contentEncoding);
  if (!inflated.ok) return inflateRefusal(inflated);
  let items: number;
  try {
    items = countOtlpItems(signal, transport, inflated.bytes);
  } catch (error) {
    if (!(error instanceof OtlpDecodeError)) throw error;
    return refusal("malformed", 400, `Malformed OTLP payload: ${error.message}`);
  }
  if (items > maxItems) {
    return refusal(
      "oversized",
      413,
      `Too many ${ITEM_NAMES[signal]} in one export (max ${maxItems}).`,
    );
  }
  const limit = (deps.publishableLimits ?? publishableIngestLimits).chargeItems(
    req,
    admission.apiKey,
    items,
  );
  return limit.allowed
    ? null
    : { response: ingestRateLimitedResponse(limit), reason: "rate_limited" };
}

/** A full-success `Export…ServiceResponse`. Nothing is stored yet, so there are no counts. */
function queuedOtlpResponse(transport: OtlpTransport): Response {
  if (transport === "json") return Response.json({}, { status: 202 });
  return new Response(new Uint8Array(0), {
    status: 202,
    headers: { "content-type": "application/x-protobuf" },
  });
}
