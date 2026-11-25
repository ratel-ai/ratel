import {
  ingestRateLimitedResponse,
  type PublishableIngestLimits,
  publishableIngestLimits,
} from "@/lib/ingest/ingest-limits";
import type { hashApiKey as hashApiKeyFn } from "@/lib/platform/api-keys";
import type { ApiKeyAuthResult } from "@/lib/platform/api-keys/authenticate";
import type { ApiKeyPolicy } from "@/lib/platform/api-keys/policy";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import type { isDbConfigured as isDbConfiguredFn } from "@/lib/platform/db/client";
import { readBodyWithCap } from "@/lib/platform/http/read-body-with-cap";
import type { findActiveApiKeyByHash as findActiveApiKeyByHashFn } from "@/lib/platform/projects/queries";
import type { ApiKey } from "@/lib/platform/projects/schema";
import { type InflateResult, MAX_BODY_BYTES, MAX_INFLATED_BYTES } from "./body";
import { type OtlpTransport, transportFor } from "./http";
import {
  type IngestEndpoint,
  type IngestObservabilityDeps,
  type IngestRejectionReason,
  rejectIngestRequest,
} from "./ingest-observability";

/** The first half of both OTLP routes: everything that the headers and the key decide. */
export interface OtlpAdmitDeps extends IngestObservabilityDeps {
  isDbConfigured: typeof isDbConfiguredFn;
  hashApiKey: typeof hashApiKeyFn;
  findActiveApiKeyByHash: typeof findActiveApiKeyByHashFn;
  /** The scope this route needs (`BEARER_ROUTE_SCOPES`). */
  scope: ApiKeyScope;
  /** Shared-key abuse limits for ingest-only keys; the process-wide budget when absent. */
  publishableLimits?: PublishableIngestLimits;
}

/** A refusal, with the reason the rejection log groups by. */
export interface Refusal {
  response: Response;
  reason: IngestRejectionReason;
}

/** Answers with a refusal and records it. */
export type RejectOtlp = (
  refusal: Refusal,
  projectId?: string,
  organizationId?: string,
) => Promise<Response>;

export function otlpRejecter(
  endpoint: IngestEndpoint,
  startedAt: number,
  deps: IngestObservabilityDeps,
): RejectOtlp {
  return ({ response, reason }, projectId, organizationId) =>
    rejectIngestRequest(response, reason, { endpoint, startedAt, deps, projectId, organizationId });
}

export type OtlpHeaders = { ok: true; transport: OtlpTransport } | { ok: false; refusal: Refusal };

/** What the headers decide, before a key lookup. No DB needed to reject a missing key. */
export function checkOtlpHeaders(
  req: Request,
  deps: Pick<OtlpAdmitDeps, "isDbConfigured">,
): OtlpHeaders {
  if (!/^Bearer\s+(.+)$/i.test(req.headers.get("authorization") ?? "")) {
    return refuse("invalid_key", 401, "Missing or malformed Authorization: Bearer <key>.");
  }
  const transport = transportFor(req.headers.get("content-type") ?? "");
  if (!transport) {
    return refuse(
      "unsupported_media",
      415,
      "Unsupported Content-Type. Send OTLP as application/x-protobuf or application/json.",
    );
  }
  const declaredLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { ok: false, refusal: bodyTooLarge() };
  }
  if (!deps.isDbConfigured()) {
    return refuse("unavailable", 503, "Ingestion is not available. Database not configured.");
  }
  return { ok: true, transport };
}

export type OtlpAdmission =
  | { ok: true; apiKey: ApiKey; policy: ApiKeyPolicy }
  | { ok: false; refusal: Refusal; projectId?: string };

/** What the key decides: its scope, and the request limits of a shared key. */
export function admitOtlpKey(
  req: Request,
  auth: ApiKeyAuthResult<ApiKey>,
  deps: Pick<OtlpAdmitDeps, "scope" | "publishableLimits">,
): OtlpAdmission {
  if (!auth.ok) {
    const { reason, status, message } = auth;
    if (reason === "forbidden") {
      const body = { error: "forbidden", reason: "missing_scope", scope: deps.scope, message };
      return {
        ok: false,
        refusal: { response: Response.json(body, { status }), reason: "missing_scope" },
      };
    }
    return refuse(reason === "unavailable" ? "unavailable" : "invalid_key", status, message);
  }
  if (auth.policy.sharedKeyLimits) {
    const limit = (deps.publishableLimits ?? publishableIngestLimits).check(req, auth.apiKey);
    if (!limit.allowed) {
      return {
        ok: false,
        refusal: { response: ingestRateLimitedResponse(limit), reason: "rate_limited" },
        projectId: auth.apiKey.projectId,
      };
    }
  }
  return { ok: true, apiKey: auth.apiKey, policy: auth.policy };
}

/** The body under the byte cap, streamed, so a chunked request never buffers past it. */
export async function readOtlpBody(
  req: Request,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; refusal: Refusal }> {
  const read = await readBodyWithCap(req, MAX_BODY_BYTES);
  return read.ok ? read : { ok: false, refusal: bodyTooLarge() };
}

export function inflateRefusal({ reason }: Extract<InflateResult, { ok: false }>): Refusal {
  switch (reason) {
    case "too_large":
      return refusal(
        "oversized",
        413,
        `Decompressed body too large (max ${MAX_INFLATED_BYTES} bytes).`,
      );
    case "unsupported":
      return refusal(
        "malformed",
        415,
        "Unsupported Content-Encoding. Send OTLP uncompressed, or with gzip or deflate.",
      );
    case "malformed":
      return refusal("malformed", 400, "Malformed compressed body.");
  }
}

export function refusal(reason: IngestRejectionReason, status: number, error: string): Refusal {
  return { response: Response.json({ error }, { status }), reason };
}

function bodyTooLarge(): Refusal {
  return refusal("oversized", 413, `Request body too large (max ${MAX_BODY_BYTES} bytes).`);
}

function refuse(
  reason: IngestRejectionReason,
  status: number,
  error: string,
): { ok: false; refusal: Refusal } {
  return { ok: false, refusal: refusal(reason, status, error) };
}
