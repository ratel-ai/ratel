import { captureOtlpRawExport, type OtlpRawCaptureDeps } from "@/lib/ingest/otlp-raw/capture";
import type { Envelope } from "@/lib/ingest/queue/envelope";
import {
  type ProcessContext,
  type Processed,
  readOtlpItems,
  reportProcessFailure,
  STORED,
} from "@/lib/ingest/queue/process";
import { getLogger, type LogError, type LogWarn } from "@/lib/platform/logger";
import type { touchApiKeyAt as touchApiKeyAtFn } from "@/lib/platform/projects/queries";
import type { reportServerException } from "@/lib/platform/telemetry";
import { MAX_LOG_RECORDS } from "./body";
import { decodeOtlpLogs } from "./decode-logs";
import { type IngestLogDeps, logLogsIngested } from "./ingest-log";
import { type IngestObservabilityDeps, trackAcceptedIngestRequest } from "./ingest-observability";
import { storableLogRows, toOtelLogRows } from "./log-rows";
import type { insertOtelLogs as insertOtelLogsFn } from "./queries";
import { type GenAiLogJoinDeps, rejoinStoredModelCalls } from "./semconv/gen-ai-log-join";
import { distinctSpanKeys } from "./semconv/gen-ai-logs";

const ENDPOINT = "/v1/logs";
const logger = getLogger("otlp/process-logs");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);
const defaultLogWarn: LogWarn = (message, fields) => logger.warn(fields, message);

export interface ProcessLogsDeps extends IngestObservabilityDeps {
  insertOtelLogs: typeof insertOtelLogsFn;
  touchApiKeyAt: typeof touchApiKeyAtFn;
  genAiLogJoin?: GenAiLogJoinDeps;
  reportServerException?: typeof reportServerException;
  otlpRawCapture?: OtlpRawCaptureDeps;
  ingestLog?: IngestLogDeps;
}

/**
 * Process (ADR-0009) for one logs envelope: the same rows as the direct route stores. A failed
 * write or join throws, and the queue delivers the envelope again: every step gives the same rows.
 */
export async function processLogs(
  envelope: Envelope,
  { projectId, organization, receivedAt }: ProcessContext,
  deps: ProcessLogsDeps,
): Promise<Processed> {
  const read = readOtlpItems(envelope, {
    decode: decodeOtlpLogs,
    maxItems: MAX_LOG_RECORDS,
    itemName: "log records",
  });
  if (!read.ok) return read.processed;
  const records = read.items;

  const logError = deps.logError ?? defaultLogError;
  const logWarn = deps.logWarn ?? defaultLogWarn;
  const startedAt = (deps.now?.() ?? new Date()).getTime();
  const captureFailure = (error: unknown) =>
    reportProcessFailure(error, { endpoint: ENDPOINT, projectId, deps, logError });
  const { appendOnlyIngest } = envelope.keyPolicy;

  const { rows, dropped } = toOtelLogRows(projectId, records, receivedAt);
  const { accepted } = await deps.insertOtelLogs(
    projectId,
    storableLogRows(rows, appendOnlyIngest),
    undefined,
    { redelivers: true },
  );
  // An append-only key never restates a stored call (RC-590).
  if (deps.genAiLogJoin && !appendOnlyIngest) {
    const keys = distinctSpanKeys(rows.filter((row) => row.eventName.startsWith("gen_ai.")));
    await rejoinStoredModelCalls(projectId, organization, keys, {
      ...deps.genAiLogJoin,
      captureFailure,
      receivedAt,
    });
  }

  await captureOtlpRawExport(
    {
      id: envelope.id,
      projectId,
      signal: "logs",
      contentType: envelope.contentType,
      body: read.bytes,
      gzipped: envelope.contentEncoding === "gzip" ? envelope.body : undefined,
      itemCount: records.length,
      traceIds: [...new Set(records.flatMap((record) => (record.traceId ? [record.traceId] : [])))],
    },
    organization,
    deps.otlpRawCapture,
    { logError, logWarn, captureFailure, trackServerEvent: deps.trackServerEvent },
  );
  await deps.touchApiKeyAt(envelope.keyId, receivedAt).catch(() => null);

  const counts = { accepted, records: records.length, dropped };
  await logLogsIngested(projectId, counts, deps.ingestLog);
  await trackAcceptedIngestRequest(counts, {
    endpoint: ENDPOINT,
    projectId,
    organizationId: organization?.id,
    startedAt,
    deps,
  });
  return { result: STORED, counts };
}
