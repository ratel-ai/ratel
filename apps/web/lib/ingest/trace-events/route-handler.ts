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
import { readBodyWithCap } from "@/lib/platform/http/read-body-with-cap";
import type { getOrganizationByProjectId as getOrganizationByProjectIdFn } from "@/lib/platform/identity/queries";
import { getLogger, type LogError } from "@/lib/platform/logger";
import type { TokenBucketRateLimiter } from "@/lib/platform/rate-limit";
import type { setRequestLogContext as setRequestLogContextFn } from "@/lib/platform/request-log";
import type { trackServerEvent as trackServerEventFn } from "@/lib/platform/telemetry";
import { reportServerException } from "@/lib/platform/telemetry";

export const MAX_BODY_BYTES = 4_000_000;
export const MAX_BATCH_EVENTS = 5_000;

export interface RuntimeEventsHandlerDeps extends IntentGraphFoldScheduleDeps {
  resolveProjectFromBearer: typeof resolveProjectFromBearerFn;
  getOrganizationByProjectId: typeof getOrganizationByProjectIdFn;
  insertTraceEvents: typeof insertTraceEventsFn;
  insertTraceEventRejects: typeof insertTraceEventRejectsFn;
  rateLimiter: TokenBucketRateLimiter;
  // The Agent health turn-ledger kick. Optional so existing callers and tests
  // are untouched; absent means no build is ever enqueued from ingest.
  traceTurns?: TraceTurnsIngestDeps;
  setRequestLogContext?: typeof setRequestLogContextFn;
  trackServerEvent?: typeof trackServerEventFn;
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

  const resolved = await deps.resolveProjectFromBearer(request);
  if (!resolved.ok) return resolved.response;

  const organization = await deps.getOrganizationByProjectId(resolved.projectId);
  deps.setRequestLogContext?.(request, {
    project_id: resolved.projectId,
    ...(organization ? { org_id: organization.id } : {}),
  });
  const rateLimit = deps.rateLimiter.consume(resolved.apiKeyId);
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

  const parsed = parseTraceEvents(body.events);
  const rejected = parsed.rejected.map(({ index, error }) => {
    const raw = body.events[index];
    return {
      index,
      event_id: metadataString(raw, "event_id"),
      reason: error,
    };
  });
  const rejectRows = parsed.rejected.map(({ index, error }) => {
    const raw = body.events[index];
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

  try {
    const { accepted } = await deps.insertTraceEvents(
      resolved.projectId,
      parsed.valid.map((event) => ({ ...event, ingestSource: "runtime" })),
      undefined,
      // The ranking-status row and the live sync serve the Cloud-built graph.
      {
        intentGraphRuntimeStatus: parsed.valid.some(
          (event) => event.type === "usage_ranking_status",
        ),
      },
    );
    await deps.insertTraceEventRejects(resolved.projectId, rejectRows);
    const duplicates = parsed.valid.length - accepted;
    if (accepted > 0 && parsed.valid.some((event) => FOLD_TRIGGER_TYPES.has(event.type))) {
      await scheduleIntentGraphFold(deps, resolved.projectId, "/api/v1/events");
    }
    await deps.trackServerEvent?.(
      "runtime_events_ingested",
      {
        projectId: resolved.projectId,
        ...(organization ? { orgId: organization.id } : {}),
      },
      {
        object_action: "runtime_events_ingested",
        received: body.events.length,
        accepted,
        duplicates,
        rejected: rejected.length,
      },
    );
    await scheduleTraceTurnBuild(deps.traceTurns, {
      projectId: resolved.projectId,
      organization,
      eventTypes: parsed.valid.map((event) => event.type),
      accepted,
      logError: deps.logError,
      reportServerException: deps.reportServerException,
    });
    return acceptedResponse(accepted, duplicates, rejected);
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
