import {
  FOLD_TRIGGER_TYPES,
  type IntentGraphFoldScheduleDeps,
  scheduleIntentGraphFold,
} from "@/lib/ingest/trace-events/fold-schedule";
import {
  contentHash,
  type ParsedTraceEvent,
  parseTraceEvents,
} from "@/lib/ingest/trace-events/parse";
import type {
  insertTraceEvents as insertTraceEventsFn,
  TraceEventRejectInput,
} from "@/lib/ingest/trace-events/queries";
import {
  scheduleTraceTurnBuild,
  type TraceTurnsIngestDeps,
} from "@/lib/ingest/trace-events/turns-schedule";
import type { Organization } from "@/lib/platform/organizations";
import type { trackServerEvent as trackServerEventFn } from "@/lib/platform/telemetry";

/** The steps of runtime-event ingest that the direct route and the queue's consumer share. */

export const MAX_BATCH_EVENTS = 5_000;
export const EVENTS_ENDPOINT = "/api/v1/events";

export type EventsBody =
  | { ok: true; events: unknown[] }
  | { ok: false; reason: "not_json" | "shape" | "too_many" };

/** The outer shape of a request body: JSON with an `events` array of a bounded length. */
export function readEventsBody(bytes: Uint8Array): EventsBody {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!isRuntimeEventsBody(decoded)) return { ok: false, reason: "shape" };
  if (decoded.events.length > MAX_BATCH_EVENTS) return { ok: false, reason: "too_many" };
  return { ok: true, events: decoded.events };
}

export interface RuntimeEventsBatch {
  received: number;
  valid: ParsedTraceEvent[];
  rejected: Array<{ index: number; event_id: string | null; reason: string }>;
  rejectRows: TraceEventRejectInput[];
}

export function parseRuntimeEvents(events: unknown[]): RuntimeEventsBatch {
  const parsed = parseTraceEvents(events);
  const rejected = parsed.rejected.map(({ index, error }) => ({
    index,
    event_id: metadataString(events[index], "event_id"),
    reason: error,
  }));
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
  return { received: events.length, valid: parsed.valid, rejected, rejectRows };
}

/** How many of the batch's valid events were new. */
export async function storeRuntimeEvents(
  projectId: string,
  { valid }: RuntimeEventsBatch,
  { appendOnly, receivedAt }: { appendOnly: boolean; receivedAt?: Date },
  insertTraceEvents: typeof insertTraceEventsFn,
): Promise<number> {
  const { accepted } = await insertTraceEvents(
    projectId,
    valid.map((event) => ({ ...event, ingestSource: "runtime" })),
    undefined,
    // The ranking-status row and the live sync serve the Cloud-built graph.
    {
      intentGraphRuntimeStatus: valid.some((event) => event.type === "usage_ranking_status"),
      // A shippable key only adds rows (RC-590): see ApiKeyPolicy.appendOnlyIngest.
      appendOnly,
      ...(receivedAt ? { receivedAt } : {}),
    },
  );
  return accepted;
}

export interface RuntimeEventJobsDeps extends IntentGraphFoldScheduleDeps {
  traceTurns?: TraceTurnsIngestDeps;
  trackServerEvent?: typeof trackServerEventFn;
}

/**
 * The jobs a stored batch starts, and its product event. With `redelivers` (the queue) a batch
 * without a new event starts them too: the delivery that stored it can have ended before that.
 */
export async function followRuntimeEvents(
  projectId: string,
  organization: Organization | null,
  batch: RuntimeEventsBatch,
  accepted: number,
  deps: RuntimeEventJobsDeps,
  { redelivers = false }: { redelivers?: boolean } = {},
): Promise<void> {
  const starting = redelivers ? batch.valid.length : accepted;
  if (starting > 0 && batch.valid.some((event) => FOLD_TRIGGER_TYPES.has(event.type))) {
    await scheduleIntentGraphFold(deps, projectId, EVENTS_ENDPOINT);
  }
  await deps.trackServerEvent?.(
    "runtime_events_ingested",
    { projectId, ...(organization ? { orgId: organization.id } : {}) },
    {
      object_action: "runtime_events_ingested",
      received: batch.received,
      accepted,
      duplicates: batch.valid.length - accepted,
      rejected: batch.rejected.length,
    },
  );
  await scheduleTraceTurnBuild(deps.traceTurns, {
    projectId,
    organization,
    eventTypes: batch.valid.map((event) => event.type),
    accepted: starting,
    logError: deps.logError,
    reportServerException: deps.reportServerException,
  });
}

function isRuntimeEventsBody(value: unknown): value is { events: unknown[] } {
  return (
    !!value && typeof value === "object" && Array.isArray((value as { events?: unknown }).events)
  );
}

function metadataString(raw: unknown, key: string): string | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === "string" ? value.slice(0, 512) : null;
}
