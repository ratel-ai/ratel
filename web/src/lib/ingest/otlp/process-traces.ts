import type { TraceMeteringPort } from "@/lib/contracts/trace-metering";
import { captureOtlpRawExport, type OtlpRawCaptureDeps } from "@/lib/ingest/otlp-raw/capture";
import type { Envelope } from "@/lib/ingest/queue/envelope";
import {
  failed,
  type ProcessContext,
  type Processed,
  readOtlpItems,
  reportProcessFailure,
  STORED,
} from "@/lib/ingest/queue/process";
import { getLogger, type LogError, type LogWarn } from "@/lib/platform/logger";
import type { touchApiKeyAt as touchApiKeyAtFn } from "@/lib/platform/projects/queries";
import type { reportServerException } from "@/lib/platform/telemetry";
import { MAX_SPANS } from "./body";
import { decodeOtlp } from "./decode";
import { type IngestLogDeps, logTracesIngested } from "./ingest-log";
import {
  type IngestObservabilityDeps,
  trackAcceptedIngestRequest,
  trackFirstTraceReceived,
} from "./ingest-observability";
import { type PersistSpansDeps, persistDecodedSpans } from "./ingest-spans";

const ENDPOINT = "/v1/traces";
const logger = getLogger("otlp/process-traces");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);
const defaultLogWarn: LogWarn = (message, fields) => logger.warn(fields, message);

export interface ProcessTracesDeps
  extends Omit<PersistSpansDeps, "logError" | "captureFailure" | "traceMetering">,
    Omit<IngestObservabilityDeps, "logError"> {
  logError?: LogError;
  touchApiKeyAt: typeof touchApiKeyAtFn;
  traceMetering?: TraceMeteringPort;
  reportServerException?: typeof reportServerException;
  otlpRawCapture?: OtlpRawCaptureDeps;
  ingestLog?: IngestLogDeps;
}

/**
 * Process (ADR-0009) for one traces envelope: the same rows as the direct route stores. Never
 * stops for the monthly cap; a trace that the meter refuses or drops is final.
 */
export async function processTraces(
  envelope: Envelope,
  { projectId, organization, receivedAt }: ProcessContext,
  deps: ProcessTracesDeps,
): Promise<Processed> {
  const read = readOtlpItems(envelope, {
    decode: decodeOtlp,
    maxItems: MAX_SPANS,
    itemName: "spans",
  });
  if (!read.ok) return read.processed;
  const spans = read.items;

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

  const persisted = await persistDecodedSpans(
    spans,
    {
      projectId,
      organization,
      ...(organization ? { quotaOrgId: organization.id } : {}),
      endpoint: ENDPOINT,
      foldIntentGraph: true,
      meterTraces,
      receivedAt,
      redelivers: true,
    },
    { ...deps, logError, captureFailure },
  );
  if (!persisted.ok && persisted.stage !== "refused") return failed(failure);
  const refused = persisted.ok ? (persisted.refused ?? 0) : spans.length;
  const dropped = persisted.ok ? (persisted.dropped ?? 0) : 0;
  if (refused > 0 || dropped > 0) {
    logWarn("trace meter kept spans out", {
      project_id: projectId,
      message_id: envelope.id,
      refused,
      dropped,
    });
  }
  if (!persisted.ok) {
    return { result: STORED, counts: { accepted: 0, calls: 0, spans: spans.length, refused } };
  }

  await logTracesIngested(projectId, spans, persisted.rows, deps.ingestLog);
  // A partly refused body holds the refused spans, so it is not kept.
  if (refused === 0) {
    await captureOtlpRawExport(
      {
        id: envelope.id,
        projectId,
        signal: "traces",
        contentType: envelope.contentType,
        body: read.bytes,
        gzipped: envelope.contentEncoding === "gzip" ? envelope.body : undefined,
        itemCount: spans.length,
        traceIds: [...new Set(spans.map((span) => span.traceId))],
      },
      organization,
      deps.otlpRawCapture,
      { logError, logWarn, captureFailure, trackServerEvent: deps.trackServerEvent },
    );
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
  const counts = { accepted: persisted.accepted, calls: persisted.calls, spans: spans.length };
  await trackAcceptedIngestRequest(counts, observation);
  return { result: STORED, counts: refused > 0 ? { ...counts, refused } : counts };
}
