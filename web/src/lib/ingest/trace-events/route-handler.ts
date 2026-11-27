import {
  ingestRateLimitedResponse,
  type PublishableIngestLimits,
  publishableIngestLimits,
} from "@/lib/ingest/ingest-limits";
import { enqueueBatch, type IngestQueueAcceptDeps } from "@/lib/ingest/queue/accept";
import {
  FOLD_TRIGGER_TYPES,
  type IntentGraphFoldScheduleDeps,
  scheduleIntentGraphFold,
} from "@/lib/ingest/trace-events/fold-schedule";
import { contentHash, parseTraceEvents } from "@/lib/ingest/trace-events/parse";
import type {
  insertTraceEventRejects as insertTraceEventRejectsFn,
  insertTraceEvents as insertTraceEventsFn,
} from "@/lib/ingest/trace-events/queries";
import {
  scheduleTraceTurnBuild,
  type TraceTurnsIngestDeps,
} from "@/lib/ingest/trace-events/turns-schedule";
import type { resolveProjectFromBearer as resolveProjectFromBearerFn } from "@/lib/platform/api-key-bearer";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import { readBodyWithCap } from "@/lib/platform/http/read-body-with-cap";
import { getLogger, type LogError } from "@/lib/platform/logger";
import type {
  getOrganizationByProjectId as getOrganizationByProjectIdFn,
  Organization,
} from "@/lib/platform/organizations";
import type { TokenBucketRateLimiter } from "@/lib/platform/rate-limit";
import type { setRequestLogContext as setRequestLogContextFn } from "@/lib/platform/request-log";
import type { trackServerEvent as trackServerEventFn } from "@/lib/platform/telemetry";
import { reportServerException } from "@/lib/platform/telemetry";

export const MAX_BODY_BYTES = 4_000_000;
export const MAX_BATCH_EVENTS = 5_000;

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
  /** The ingest queue (RTL-314); absent or off, every batch is stored in the request. */
  ingestQueue?: IngestQueueAcceptDeps;
}

type RuntimeEventsBody = { events: unknown[] };

const logger = getLogger("trace-events/route-handler");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);

/** API-key-authenticated, partial-success runtime-event ingest. */
export async function handleRuntimeEventsRequest(
  request: Request,
  deps: RuntimeEventsHandlerDeps,
): Promise<Response> {
  if (!isJson(request.headers.get("content-type"))) {
    return json({ error: "Unsupported Content-Type. Send application/json." }, 415);
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return tooLarge(`Request body too large (max ${MAX_BODY_BYTES} bytes).`);
  }

  const resolved = await deps.resolveProjectFromBearer(request, deps.scope);
  if (!resolved.ok) return resolved.response;

  const organization = await deps.getOrganizationByProjectId(resolved.projectId);
  deps.setRequestLogContext?.(request, {
    project_id: resolved.projectId,
    ...(organization ? { org_id: organization.id } : {}),
  });
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

  let body: RuntimeEventsBody;
  try {
    const decoded = JSON.parse(new TextDecoder().decode(read.bytes)) as unknown;
    if (!isRuntimeEventsBody(decoded)) {
      return json({ error: "Malformed runtime-events payload: expected { events: [] }." }, 400);
    }
    body = decoded;
  } catch {
    return json({ error: "Malformed JSON payload." }, 400);
  }
  if (body.events.length > MAX_BATCH_EVENTS) {
    return tooLarge(`Too many events in one batch (max ${MAX_BATCH_EVENTS}).`);
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

  // The ingest queue (RTL-314): keep the body and answer; a worker stores the events. An
  // ingest-only key stays inline, as for the OTLP routes.
  if (deps.ingestQueue?.enabled() && !resolved.policy.sharedKeyLimits) {
    const queued = await enqueueBatch(
      {
        projectId: resolved.projectId,
        signal: "events",
        contentType: "application/json",
        contentEncoding: null,
        body: read.bytes,
        context: { appendOnly: resolved.policy.appendOnlyIngest },
      },
      deps.ingestQueue,
      {
        logError: deps.logError ?? defaultLogError,
        captureFailure: (error) =>
          (deps.reportServerException ?? reportServerException)(
            error,
            `project:${resolved.projectId}`,
            { endpoint: "/api/v1/events" },
          ),
      },
    );
    if (!queued.ok) return json({ error: "Failed to store runtime events." }, 500);
    // The body's shape is kept, so a client reading it still parses: nothing is stored yet.
    return json({ accepted: 0, duplicates: 0, rejected: [], queued: body.events.length }, 202);
  }

  try {
    const stored = await storeRuntimeEvents(
      body.events,
      {
        projectId: resolved.projectId,
        organization,
        appendOnly: resolved.policy.appendOnlyIngest,
      },
      deps,
    );
    return acceptedResponse(stored.accepted, stored.duplicates, stored.rejected);
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

export type StoreRuntimeEventsDeps = Pick<
  RuntimeEventsHandlerDeps,
  | "insertTraceEvents"
  | "insertTraceEventRejects"
  | "traceTurns"
  | "trackServerEvent"
  | "logError"
  | "reportServerException"
  | keyof IntentGraphFoldScheduleDeps
>;

export interface StoredRuntimeEvents {
  accepted: number;
  duplicates: number;
  rejected: Array<{ index: number; event_id: string | null; reason: string }>;
}

/**
 * Validate and store a batch of runtime events, report its rejects, and kick the fold and the turn
 * build: the write half of `/api/v1/events`, shared by the route and the ingest queue's worker
 * (RTL-314). Throws when the write fails.
 */
export async function storeRuntimeEvents(
  events: unknown[],
  context: {
    projectId: string;
    organization: Organization | null;
    appendOnly: boolean;
    /** When a queued batch was accepted (ADR-0010): the clock that bounds the facts. Absent, now. */
    receivedAt?: Date;
    /** A batch without a new event starts its jobs too: the try that stored it can have ended before. */
    redelivers?: boolean;
  },
  deps: StoreRuntimeEventsDeps,
): Promise<StoredRuntimeEvents> {
  const { projectId, organization } = context;
  const parsed = parseTraceEvents(events);
  const rejected = parsed.rejected.map(({ index, error }) => {
    const raw = events[index];
    return {
      index,
      event_id: metadataString(raw, "event_id"),
      reason: error,
    };
  });
  const rejectRows = parsed.rejected.map(({ index, error }) => {
    const raw = events[index];
    return {
      eventId: metadataString(raw, "event_id"),
      type: metadataString(raw, "type"),
      reason: error,
      sizeBytes: Buffer.byteLength(JSON.stringify(raw ?? null), "utf8"),
      sourceId: metadataString(raw, "source_id"),
      // Distinguishes anonymous rejects in the ledger; identical retries collide.
      payloadHash: contentHash(raw ?? null),
    };
  });

  const { accepted } = await deps.insertTraceEvents(
    projectId,
    parsed.valid.map((event) => ({ ...event, ingestSource: "runtime" })),
    undefined,
    // The ranking-status row and the live sync serve the Cloud-built graph.
    {
      intentGraphRuntimeStatus: parsed.valid.some((event) => event.type === "usage_ranking_status"),
      // A shippable key only adds rows (RC-590): see ApiKeyPolicy.appendOnlyIngest.
      appendOnly: context.appendOnly,
      ...(context.receivedAt ? { receivedAt: context.receivedAt } : {}),
    },
  );
  await deps.insertTraceEventRejects(projectId, rejectRows);
  const duplicates = parsed.valid.length - accepted;
  const starting = context.redelivers ? parsed.valid.length : accepted;
  if (starting > 0 && parsed.valid.some((event) => FOLD_TRIGGER_TYPES.has(event.type))) {
    await scheduleIntentGraphFold(deps, projectId, "/api/v1/events");
  }
  await deps.trackServerEvent?.(
    "runtime_events_ingested",
    { projectId, ...(organization ? { orgId: organization.id } : {}) },
    {
      object_action: "runtime_events_ingested",
      received: events.length,
      accepted,
      duplicates,
      rejected: rejected.length,
    },
  );
  await scheduleTraceTurnBuild(deps.traceTurns, {
    projectId,
    organization,
    eventTypes: parsed.valid.map((event) => event.type),
    accepted: starting,
    logError: deps.logError,
    reportServerException: deps.reportServerException,
  });
  return { accepted, duplicates, rejected };
}

/** A queued events body, parsed again by the worker; null when it is not `{ events: [] }`. */
export function parseRuntimeEventsBody(bytes: Uint8Array): unknown[] | null {
  try {
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return isRuntimeEventsBody(decoded) ? decoded.events : null;
  } catch {
    return null;
  }
}

function acceptedResponse(
  accepted: number,
  duplicates: number,
  rejected: Array<{ index: number; event_id: string | null; reason: string }>,
): Response {
  return json({ accepted, duplicates, rejected }, 202);
}

function isRuntimeEventsBody(value: unknown): value is RuntimeEventsBody {
  return (
    !!value && typeof value === "object" && Array.isArray((value as { events?: unknown }).events)
  );
}

function metadataString(raw: unknown, key: string): string | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === "string" ? value.slice(0, 512) : null;
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
