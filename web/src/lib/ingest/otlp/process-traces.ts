import type { TraceMeteringPort } from "@/lib/contracts/trace-metering";
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
import {
  type IngestObservabilityDeps,
  trackAcceptedIngestRequest,
  trackFirstTraceReceived,
} from "./ingest-observability";
import {
  decodeTraceExport,
  MAX_SPANS,
  type StoreTracesDeps,
  storeTraceExport,
} from "./traces-export";

const ENDPOINT = "/v1/traces";
const logger = getLogger("otlp/process-traces");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);
const defaultLogWarn: LogWarn = (message, fields) => logger.warn(fields, message);

export interface ProcessTracesDeps extends StoreTracesDeps, IngestObservabilityDeps {
  touchApiKeyAt: typeof touchApiKeyAtFn;
  traceMetering?: TraceMeteringPort;
  reportServerException?: typeof reportServerException;
}

/**
 * Process (ADR-0010) for one traces envelope, through `storeTraceExport`: the same rows as the route
 * stores. Never stops for the monthly cap; a trace that the meter refuses or drops is final.
 */
export async function processTraces(
  envelope: Envelope,
  { projectId, organization, receivedAt }: ProcessContext,
  deps: ProcessTracesDeps,
): Promise<Processed> {
  const read = readOtlpExport(envelope, { decode: decodeTraceExport, limit: `${MAX_SPANS} spans` });
  if (!read.ok) return read.processed;
  const { spans } = read.decoded;

  const logError = deps.logError ?? defaultLogError;
  const logWarn = deps.logWarn ?? defaultLogWarn;
  const startedAt = (deps.now?.() ?? new Date()).getTime();
  let failure: unknown;
  const captureFailure = (error: unknown) => {
    failure = error;
    reportProcessFailure(error, { endpoint: ENDPOINT, projectId, deps, logError });
  };
  const meterTraces =
    organization && deps.traceMetering
      ? await deps.traceMetering.isMetered({ organization, projectId })
      : false;

  const stored = await storeTraceExport(
    spans,
    {
      projectId,
      organization,
      ...(organization ? { quotaOrgId: organization.id } : {}),
      meterTraces,
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
  if (!stored.ok && stored.stage !== "refused") return failed(failure);
  const refused = stored.ok ? (stored.refused ?? 0) : spans.length;
  const dropped = stored.ok ? (stored.dropped ?? 0) : 0;
  if (refused > 0 || dropped > 0) {
    logWarn("trace meter kept spans out", {
      project_id: projectId,
      message_id: envelope.id,
      refused,
      dropped,
    });
  }
  if (!stored.ok) {
    return { result: STORED, counts: { accepted: 0, calls: 0, spans: spans.length, refused } };
  }

  const observation = {
    endpoint: ENDPOINT,
    projectId,
    organizationId: organization?.id,
    startedAt,
    deps,
  } as const;
  const touched = await deps.touchApiKeyAt(envelope.keyId, receivedAt).catch(() => null);
  if (touched?.first) await trackFirstTraceReceived(observation);
  const counts = { accepted: stored.accepted, calls: stored.calls, spans: spans.length };
  await trackAcceptedIngestRequest(counts, observation);
  return { result: STORED, counts: refused > 0 ? { ...counts, refused } : counts };
}
