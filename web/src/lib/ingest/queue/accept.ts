import type { LogError } from "@/lib/platform/logger";
import type { NewIngestBatch } from "./queries";
import type { IngestBatchSignal } from "./schema";

/**
 * The request half of the ingest queue (RTL-314): store the accepted body durably and kick a
 * drain. The route has already authenticated, checked the plan cap and the body's size; nothing
 * here decodes.
 */
export interface IngestQueueAcceptDeps {
  /** `EXPERIMENTAL_INGEST_QUEUE`, read per request. */
  enabled: () => boolean;
  enqueue: (batch: NewIngestBatch) => Promise<{ id: string }>;
  /** Persist soon: after the response on an all-in-one process, nothing where a worker does. */
  scheduleDrain: () => void;
}

export interface OtlpBatchInput {
  projectId: string;
  signal: Extract<IngestBatchSignal, "traces" | "logs">;
  transport: "json" | "protobuf";
  /** The body as it arrived, before any inflate. */
  received: Uint8Array;
  contentEncoding: string | null;
  appendOnly: boolean;
}

export type EnqueueResult = { ok: true; id: string } | { ok: false };

/**
 * Queue an OTLP export. A compressed body is kept compressed (the worker inflates it again,
 * cheaply), so the stored bytes stay what the exporter sent.
 */
export async function enqueueOtlpBatch(
  input: OtlpBatchInput,
  deps: IngestQueueAcceptDeps,
  observers: { logError: LogError; captureFailure: (error: unknown) => void },
): Promise<EnqueueResult> {
  return enqueueBatch(
    {
      projectId: input.projectId,
      signal: input.signal,
      contentType: input.transport === "json" ? "application/json" : "application/x-protobuf",
      contentEncoding: storedEncoding(input.contentEncoding),
      body: input.received,
      context: { appendOnly: input.appendOnly },
    },
    deps,
    observers,
  );
}

/** Queue any batch, logging and reporting a failed write; the caller answers 500 on `ok: false`. */
export async function enqueueBatch(
  batch: NewIngestBatch,
  deps: IngestQueueAcceptDeps,
  observers: { logError: LogError; captureFailure: (error: unknown) => void },
): Promise<EnqueueResult> {
  let id: string;
  try {
    ({ id } = await deps.enqueue(batch));
  } catch (error) {
    observers.logError("ingest batch enqueue failed", error, {
      project_id: batch.projectId,
      signal: batch.signal,
      body_bytes: batch.body.byteLength,
    });
    observers.captureFailure(error);
    return { ok: false };
  }
  deps.scheduleDrain();
  return { ok: true, id };
}

/** `gzip` or `deflate` for a body still compressed; null for one sent as is. */
export function storedEncoding(contentEncoding: string | null): "gzip" | "deflate" | null {
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") return "gzip";
  if (encoding === "deflate") return "deflate";
  return null;
}
