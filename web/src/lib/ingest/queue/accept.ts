import { randomUUID } from "node:crypto";
import { ENVELOPE_VERSION, type Envelope } from "@/lib/ingest/queue/envelope";
import type { EnvelopeQueue } from "@/lib/ingest/queue/port/envelope-queue";
import { errorReason } from "@/lib/ingest/queue/port/settle";
import type { ApiKeyPolicy } from "@/lib/platform/api-keys/policy";
import { getLogger } from "@/lib/platform/logger";

const logger = getLogger("ingest:accept");

/** A publish that does not confirm in this time is a failure (ADR-0009). */
export const PUBLISH_TIMEOUT_MS = 10_000;

/** What a route needs to accept a request onto the queue. Absent, the route runs in direct mode. */
export interface AcceptDeps {
  queue: Pick<EnvelopeQueue, "publish">;
  /** The project's organization id, from its row; null when the project is gone. */
  findOrganizationId: (projectId: string) => Promise<string | null>;
  publishTimeoutMs?: number;
}

export interface AcceptedRequest
  extends Pick<
    Envelope,
    | "projectId"
    | "organizationId"
    | "keyId"
    | "signal"
    | "contentType"
    | "contentEncoding"
    | "receivedAt"
    | "body"
  > {
  policy: Pick<ApiKeyPolicy, "appendOnlyIngest" | "sharedKeyLimits">;
}

/** Publishes one accepted request. False when the queue did not confirm it. */
export async function publishRequest(
  { policy, ...request }: AcceptedRequest,
  { queue, publishTimeoutMs = PUBLISH_TIMEOUT_MS }: AcceptDeps,
): Promise<boolean> {
  const envelope: Envelope = {
    version: ENVELOPE_VERSION,
    id: randomUUID(),
    ...request,
    keyPolicy: {
      appendOnlyIngest: policy.appendOnlyIngest,
      sharedKeyLimits: policy.sharedKeyLimits,
    },
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PublishTimeoutError()), publishTimeoutMs);
    });
    await Promise.race([queue.publish(envelope), timeout]);
    return true;
  } catch (error) {
    logger.error(
      {
        reason: errorReason(error),
        project_id: envelope.projectId,
        signal: envelope.signal,
        message_id: envelope.id,
        bytes: envelope.body.byteLength,
      },
      "publish ingest message failed",
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

class PublishTimeoutError extends Error {
  override name = "PublishTimeoutError";
}

/** The one refusal that only the queue adds. */
export function queueUnavailableResponse(): Response {
  return Response.json(
    { error: "Ingestion is not available. Try again." },
    { status: 503, headers: { "Retry-After": "5" } },
  );
}
