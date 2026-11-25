import { getConfig } from "@/config";
import type { AcceptDeps } from "@/lib/ingest/queue/accept";
import type { EnvelopeQueue } from "@/lib/ingest/queue/port/envelope-queue";
import { createPostgresQueue } from "@/lib/ingest/queue/postgres/postgres-queue";
import { getProjectById } from "@/lib/platform/projects/queries";

let opened: EnvelopeQueue | undefined;

/** The queue that `INGEST_QUEUE` names; null in direct mode, which has none. */
export async function ingestQueue(): Promise<EnvelopeQueue | null> {
  const kind = getConfig().ingest.queue;
  if (kind === "direct") return null;
  if (kind === "kafka") throw new Error("INGEST_QUEUE=kafka has no driver in this build");
  opened ??= createPostgresQueue();
  return opened;
}

/** What an ingest route accepts with; undefined in direct mode. */
export async function ingestAccept(): Promise<AcceptDeps | undefined> {
  const queue = await ingestQueue();
  if (!queue) return undefined;
  return {
    queue,
    findOrganizationId: async (projectId) =>
      (await getProjectById(projectId))?.organizationId ?? null,
  };
}
