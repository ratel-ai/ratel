import { getConfig } from "@/config";
import { composition } from "@/lib/composition/ports";
import type { AcceptDeps } from "@/lib/ingest/queue/accept";
import type { EnvelopeQueue } from "@/lib/ingest/queue/port/envelope-queue";
import { getProjectById } from "@/lib/platform/projects/queries";

let opened: Promise<EnvelopeQueue> | undefined;

/** The queue that `INGEST_QUEUE` names; null in direct mode, which has none. */
export async function ingestQueue(): Promise<EnvelopeQueue | null> {
  const { ingest } = getConfig();
  if (ingest.queue === "direct") return null;
  opened ??= open();
  try {
    return await opened;
  } catch (error) {
    opened = undefined;
    throw error;
  }
}

/** Each driver loads only when it is the configured one. */
async function open(): Promise<EnvelopeQueue> {
  const { ingest } = getConfig();
  if (ingest.queue === "kafka") {
    const { openKafkaQueue } = await import("@/lib/ingest/queue/kafka/open");
    return openKafkaQueue(ingest, composition.ingestTopics);
  }
  const { createPostgresQueue } = await import("@/lib/ingest/queue/postgres/postgres-queue");
  return createPostgresQueue();
}

/** Tests only: the next `ingestQueue()` opens the configured queue again. */
export function resetIngestQueueForTests(): void {
  opened = undefined;
}

/**
 * What an ingest route accepts with; undefined in direct mode, and with Kafka that this deployment
 * only consumes (no topic to publish to): its own routes then store as in direct mode.
 */
export async function ingestAccept(): Promise<AcceptDeps | undefined> {
  const { ingest } = getConfig();
  if (ingest.queue === "kafka" && !ingest.kafka.topic) return undefined;
  const queue = await ingestQueue();
  if (!queue) return undefined;
  return {
    queue,
    findOrganizationId: async (projectId) =>
      (await getProjectById(projectId))?.organizationId ?? null,
  };
}
