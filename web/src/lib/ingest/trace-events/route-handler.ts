import {
  ingestRateLimitedResponse,
  type PublishableIngestLimits,
  publishableIngestLimits,
} from "@/lib/ingest/ingest-limits";
import {
  type AcceptDeps,
  publishRequest,
  queueUnavailableResponse,
} from "@/lib/ingest/queue/accept";
import type { IntentGraphFoldScheduleDeps } from "@/lib/ingest/trace-events/fold-schedule";
import type {
  insertTraceEventRejects as insertTraceEventRejectsFn,
  insertTraceEvents as insertTraceEventsFn,
} from "@/lib/ingest/trace-events/queries";
import type { TraceTurnsIngestDeps } from "@/lib/ingest/trace-events/turns-schedule";
import type { resolveProjectFromBearer as resolveProjectFromBearerFn } from "@/lib/platform/api-key-bearer";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import { readBodyWithCap } from "@/lib/platform/http/read-body-with-cap";
import { getLogger, type LogError } from "@/lib/platform/logger";
import type { getOrganizationByProjectId as getOrganizationByProjectIdFn } from "@/lib/platform/organizations";
import type { TokenBucketRateLimiter } from "@/lib/platform/rate-limit";
import type { setRequestLogContext as setRequestLogContextFn } from "@/lib/platform/request-log";
import type { trackServerEvent as trackServerEventFn } from "@/lib/platform/telemetry";
import { reportServerException } from "@/lib/platform/telemetry";
import {
  followRuntimeEvents,
  MAX_BATCH_EVENTS,
  parseRuntimeEvents,
  readEventsBody,
  storeRuntimeEvents,
} from "./ingest-events";

export const MAX_BODY_BYTES = 4_000_000;
export { MAX_BATCH_EVENTS } from "./ingest-events";

export interface RuntimeEventsHandlerDeps extends IntentGraphFoldScheduleDeps {
  /** The scope this route needs (`BEARER_ROUTE_SCOPES`). */
  scope: ApiKeyScope;
  resolveProjectFromBearer: typeof resolveProjectFromBearerFn;
  getOrganizationByProjectId: typeof getOrganizationByProjectIdFn;
  insertTraceEvents: typeof insertTraceEventsFn;
  insertTraceEventRejects: typeof insertTraceEventRejectsFn;
  rateLimiter: TokenBucketRateLimiter;
  /** Shared-key abuse limits for ingest-only keys; the process-wide budget when absent. */
  publishableLimits?: PublishableIngestLimits;
  // The Agent health turn-ledger kick. Optional so existing callers and tests
  // are untouched; absent means no build is ever enqueued from ingest.
  traceTurns?: TraceTurnsIngestDeps;
  setRequestLogContext?: typeof setRequestLogContextFn;
  trackServerEvent?: typeof trackServerEventFn;
  /** Accept onto the queue (ADR-0009) instead of storing in the request. Absent, direct mode. */
  accept?: AcceptDeps;
  now?: () => Date;
}

const logger = getLogger("trace-events/route-handler");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);

/** API-key-authenticated, partial-success runtime-event ingest. */
export async function handleRuntimeEventsRequest(
  request: Request,
  deps: RuntimeEventsHandlerDeps,
): Promise<Response> {
  const receivedAt = deps.now?.().getTime() ?? Date.now();
  if (!isJson(request.headers.get("content-type"))) {
    return json({ error: "Unsupported Content-Type. Send application/json." }, 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return tooLarge(`Request body too large (max ${MAX_BODY_BYTES} bytes).`);
  }

  const resolved = await deps.resolveProjectFromBearer(request, deps.scope);
  if (!resolved.ok) return resolved.response;

  const organization = deps.accept
    ? null
    : await deps.getOrganizationByProjectId(resolved.projectId);
  const organizationId = deps.accept
    ? await deps.accept.findOrganizationId(resolved.projectId)
    : organization?.id;
  deps.setRequestLogContext?.(request, {
    project_id: resolved.projectId,
    ...(organizationId ? { org_id: organizationId } : {}),
  });
  if (deps.accept && !organizationId) {
    // The project was deleted after the key was read, and its keys with it.
    return json({ error: "Invalid or revoked API key." }, 401);
  }
  // An ingest-only key is shared by every install of an app, so it gets the
  // shared-key budget (higher per key, plus per source) instead of the
  // per-client one a secret key has always had.
  if (resolved.policy.sharedKeyLimits) {
    const limit = (deps.publishableLimits ?? publishableIngestLimits).check(request, {
      id: resolved.apiKeyId,
      rateLimitPerMinute: resolved.rateLimitPerMinute,
    });
    if (!limit.allowed) return ingestRateLimitedResponse(limit);
  }
  const rateLimit = resolved.policy.sharedKeyLimits
    ? { allowed: true as const }
    : deps.rateLimiter.consume(resolved.apiKeyId);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Rate limit exceeded." },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  const read = await readBodyWithCap(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return tooLarge(`Request body too large (max ${MAX_BODY_BYTES} bytes).`);
  }

  const body = readEventsBody(read.bytes);
  if (!body.ok) {
    switch (body.reason) {
      case "not_json":
        return json({ error: "Malformed JSON payload." }, 400);
      case "shape":
        return json({ error: "Malformed runtime-events payload: expected { events: [] }." }, 400);
      case "too_many":
        return tooLarge(`Too many events in one batch (max ${MAX_BATCH_EVENTS}).`);
    }
  }
  // An ingest-only key's budget counts events too, not only requests (RC-585).
  if (resolved.policy.sharedKeyLimits) {
    const items = (deps.publishableLimits ?? publishableIngestLimits).chargeItems(
      request,
      { id: resolved.apiKeyId, rateLimitPerMinute: resolved.rateLimitPerMinute },
      body.events.length,
    );
    if (!items.allowed) return ingestRateLimitedResponse(items);
  }

  if (deps.accept && organizationId) {
    const published = await publishRequest(
      {
        projectId: resolved.projectId,
        organizationId,
        keyId: resolved.apiKeyId,
        policy: resolved.policy,
        signal: "events",
        contentType: "application/json",
        contentEncoding: "identity",
        receivedAt,
        body: read.bytes,
      },
      deps.accept,
    );
    // Nothing is parsed or stored yet: every event counts as accepted.
    return published ? acceptedResponse(body.events.length, 0, []) : queueUnavailableResponse();
  }

  const batch = parseRuntimeEvents(body.events);
  try {
    const accepted = await storeRuntimeEvents(
      resolved.projectId,
      batch,
      { appendOnly: resolved.policy.appendOnlyIngest },
      deps.insertTraceEvents,
    );
    await deps.insertTraceEventRejects(resolved.projectId, batch.rejectRows);
    await followRuntimeEvents(resolved.projectId, organization, batch, accepted, deps);
    return acceptedResponse(accepted, batch.valid.length - accepted, batch.rejected);
  } catch (error) {
    (deps.logError ?? defaultLogError)("runtime event insert failed", error, {
      project_id: resolved.projectId,
    });
    (deps.reportServerException ?? reportServerException)(error, `project:${resolved.projectId}`, {
      endpoint: "/api/v1/events",
    });
    return json({ error: "Failed to store runtime events." }, 500);
  }
}

function acceptedResponse(
  accepted: number,
  duplicates: number,
  rejected: Array<{ index: number; event_id: string | null; reason: string }>,
): Response {
  return json({ accepted, duplicates, rejected }, 202);
}

function isJson(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function tooLarge(error: string): Response {
  return json({ error }, 413);
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}
