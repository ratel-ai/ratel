import type { Envelope } from "@/lib/ingest/queue/envelope";
import {
  deadLetter,
  type ProcessContext,
  type Processed,
  STORED,
} from "@/lib/ingest/queue/process";
import type {
  insertTraceEventRejects as insertTraceEventRejectsFn,
  insertTraceEvents as insertTraceEventsFn,
} from "@/lib/ingest/trace-events/queries";
import type { touchApiKeyAt as touchApiKeyAtFn } from "@/lib/platform/projects/queries";
import {
  type EventsBody,
  followRuntimeEvents,
  MAX_BATCH_EVENTS,
  parseRuntimeEvents,
  type RuntimeEventJobsDeps,
  readEventsBody,
  storeRuntimeEvents,
} from "./ingest-events";

export interface ProcessEventsDeps extends RuntimeEventJobsDeps {
  insertTraceEvents: typeof insertTraceEventsFn;
  insertTraceEventRejects: typeof insertTraceEventRejectsFn;
  touchApiKeyAt: typeof touchApiKeyAtFn;
}

/** What accept refuses, for a writer that let it through. */
const REFUSALS: Record<Extract<EventsBody, { ok: false }>["reason"], string> = {
  not_json: "body is not JSON",
  shape: "body has no events array",
  too_many: `body has more than ${MAX_BATCH_EVENTS} events`,
};

/** Process (ADR-0009) for one events envelope: the same rows and jobs as the direct route. */
export async function processEvents(
  envelope: Envelope,
  { projectId, organization, receivedAt }: ProcessContext,
  deps: ProcessEventsDeps,
): Promise<Processed> {
  const body = readEventsBody(envelope.body);
  if (!body.ok) return deadLetter(REFUSALS[body.reason]);
  const batch = parseRuntimeEvents(body.events);

  // The rejects first: the jobs follow the events at once, so a failure after the events are
  // stored cannot cost the next delivery its jobs.
  await deps.insertTraceEventRejects(projectId, batch.rejectRows);
  const accepted = await storeRuntimeEvents(
    projectId,
    batch,
    { appendOnly: envelope.keyPolicy.appendOnlyIngest, receivedAt },
    deps.insertTraceEvents,
  );
  await followRuntimeEvents(projectId, organization, batch, accepted, deps);
  await deps.touchApiKeyAt(envelope.keyId, receivedAt).catch(() => null);
  return {
    result: STORED,
    counts: {
      received: batch.received,
      accepted,
      duplicates: batch.valid.length - accepted,
      rejected: batch.rejected.length,
    },
  };
}
