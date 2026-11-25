import type { Envelope } from "@/lib/ingest/queue/envelope";
import {
  failed,
  type ProcessContext,
  type Processed,
  readOtlpExport,
  reportProcessFailure,
  STORED,
  transportOf,
} from "@/lib/ingest/queue/process";
import { getLogger, type LogError, type LogWarn } from "@/lib/platform/logger";
import type { touchApiKeyAt as touchApiKeyAtFn } from "@/lib/platform/projects/queries";
import type { reportServerException } from "@/lib/platform/telemetry";
import { type IngestObservabilityDeps, trackAcceptedIngestRequest } from "./ingest-observability";
import {
  decodeLogExport,
  MAX_LOG_RECORDS,
  type StoreLogsDeps,
  storeLogExport,
} from "./logs-export";

const ENDPOINT = "/v1/logs";
const logger = getLogger("otlp/process-logs");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);
const defaultLogWarn: LogWarn = (message, fields) => logger.warn(fields, message);

export interface ProcessLogsDeps extends StoreLogsDeps, IngestObservabilityDeps {
  touchApiKeyAt: typeof touchApiKeyAtFn;
  reportServerException?: typeof reportServerException;
}

/**
 * Process (ADR-0010) for one logs envelope, through `storeLogExport`: the same rows as the route
 * stores. A failed write or join delivers the envelope again: every step gives the same rows.
 */
export async function processLogs(
  envelope: Envelope,
  { projectId, organization, receivedAt }: ProcessContext,
  deps: ProcessLogsDeps,
): Promise<Processed> {
  const read = readOtlpExport(envelope, {
    decode: decodeLogExport,
    limit: `${MAX_LOG_RECORDS} log records`,
  });
  if (!read.ok) return read.processed;

  const logError = deps.logError ?? defaultLogError;
  const logWarn = deps.logWarn ?? defaultLogWarn;
  const startedAt = (deps.now?.() ?? new Date()).getTime();
  let failure: unknown;
  const captureFailure = (error: unknown) => {
    failure = error;
    reportProcessFailure(error, { endpoint: ENDPOINT, projectId, deps, logError });
  };
  const stored = await storeLogExport(
    read.decoded.records,
    {
      projectId,
      organization,
      appendOnly: envelope.keyPolicy.appendOnlyIngest,
      transport: transportOf(envelope),
      body: read.bytes,
      ...(envelope.contentEncoding === "gzip" ? { gzipped: envelope.body } : {}),
      receivedAt,
      redelivers: true,
      captureId: envelope.id,
    },
    deps,
    { logError, logWarn, captureFailure },
  );
  if (!stored.ok) return failed(failure);

  await deps.touchApiKeyAt(envelope.keyId, receivedAt).catch(() => null);
  const counts = {
    accepted: stored.accepted,
    records: stored.records,
    dropped: stored.dropped,
  };
  await trackAcceptedIngestRequest(counts, {
    endpoint: ENDPOINT,
    projectId,
    organizationId: organization?.id,
    startedAt,
    deps,
  });
  return { result: STORED, counts };
}
