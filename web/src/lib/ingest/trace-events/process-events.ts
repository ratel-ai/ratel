import type { Envelope } from "@/lib/ingest/queue/envelope";
import {
  deadLetter,
  type ProcessContext,
  type Processed,
  STORED,
} from "@/lib/ingest/queue/process";
import type { touchApiKeyAt as touchApiKeyAtFn } from "@/lib/platform/projects/queries";
import {
  MAX_BATCH_EVENTS,
  parseRuntimeEventsBody,
  type StoreRuntimeEventsDeps,
  storeRuntimeEvents,
} from "./route-handler";

export interface ProcessEventsDeps extends StoreRuntimeEventsDeps {
  touchApiKeyAt: typeof touchApiKeyAtFn;
}

/**
 * Process (ADR-0010) for one events envelope, through `storeRuntimeEvents`: the same rows and jobs as
 * the route. What the route refuses is a dead letter, for a writer that let it through.
 */
export async function processEvents(
  envelope: Envelope,
  { projectId, organization, receivedAt }: ProcessContext,
  deps: ProcessEventsDeps,
): Promise<Processed> {
  const events = parseRuntimeEventsBody(envelope.body);
  if (!events) return deadLetter("body is not JSON with an events array");
  if (events.length > MAX_BATCH_EVENTS) {
    return deadLetter(`body has more than ${MAX_BATCH_EVENTS} events`);
  }
  const { accepted, duplicates, rejected } = await storeRuntimeEvents(
    events,
    {
      projectId,
      organization,
      appendOnly: envelope.keyPolicy.appendOnlyIngest,
      receivedAt,
      redelivers: true,
    },
    deps,
  );
  await deps.touchApiKeyAt(envelope.keyId, receivedAt).catch(() => null);
  return {
    result: STORED,
    counts: { received: events.length, accepted, duplicates, rejected: rejected.length },
  };
}
