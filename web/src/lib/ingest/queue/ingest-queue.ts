import { getConfig } from "@/config";
import { composition } from "@/lib/composition/ports";
import type { EnvelopeQueue } from "@/lib/ingest/queue/port/envelope-queue";

let opened: Promise<EnvelopeQueue> | undefined;

/** The queue that `INGEST_QUEUE` names (ADR-0010); null without one. The driver loads only then. */
export async function ingestQueue(): Promise<EnvelopeQueue | null> {
  const { ingest } = getConfig();
  if (ingest.queue !== "kafka") return null;
  opened ??= (async () => {
    const { openKafkaQueue } = await import("@/lib/ingest/queue/kafka/open");
    return openKafkaQueue(ingest, composition.ingestTopics);
  })();
  try {
    return await opened;
  } catch (error) {
    opened = undefined;
    throw error;
  }
}

/** Tests only: the next `ingestQueue()` opens the configured queue again. */
export function resetIngestQueueForTests(): void {
  opened = undefined;
}
