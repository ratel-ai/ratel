import type { TraceMeteringPort } from "@/lib/contracts/trace-metering";
import type { OtlpTransport } from "@/lib/ingest/otlp/http";
import { decodeLogExport, type StoreLogsDeps, storeLogExport } from "@/lib/ingest/otlp/logs-export";
import { inflateBody, isGzipEncoding, MAX_INFLATED_BYTES } from "@/lib/ingest/otlp/route-handler";
import {
  decodeTraceExport,
  type StoreTracesDeps,
  storeTraceExport,
} from "@/lib/ingest/otlp/traces-export";
import {
  parseRuntimeEventsBody,
  type StoreRuntimeEventsDeps,
  storeRuntimeEvents,
} from "@/lib/ingest/trace-events/route-handler";
import type { LogError, LogWarn } from "@/lib/platform/logger";
import type { getOrganizationByProjectId as getOrganizationByProjectIdFn } from "@/lib/platform/organizations";
import type { reportServerException as reportServerExceptionFn } from "@/lib/platform/telemetry";
import type { ClaimedIngestBatch } from "./queries";

/**
 * The worker half of the ingest queue (RTL-314): decode a claimed batch and store it through the
 * same functions the inline routes call (`storeTraceExport` → `persistDecodedSpans`,
 * `storeLogExport`, `storeRuntimeEvents`). Every row id those write is deterministic, so a batch
 * that runs twice adds nothing the second time. The raw body capture is not keyed, so only a
 * batch's first try keeps it: a later try may follow one that kept it already.
 */
export interface IngestPersistDeps {
  getOrganizationByProjectId?: typeof getOrganizationByProjectIdFn;
  /** With `traceMetering.isMetered`: the edition decides each trace, as at the inline route. */
  traces: StoreTracesDeps & { traceMetering?: TraceMeteringPort };
  logs: StoreLogsDeps;
  events: Omit<StoreRuntimeEventsDeps, "logError" | "reportServerException">;
  logError: LogError;
  logWarn: LogWarn;
  reportServerException: typeof reportServerExceptionFn;
}

/**
 * `done`: stored (or deliberately not: refused by the edition's bounds). `failed`: no retry can
 * fix it (it does not decode). `retry`: the write failed and may not next time.
 */
export type PersistOutcome =
  | { kind: "done"; result: Record<string, unknown> }
  | { kind: "failed"; error: string }
  | { kind: "retry"; error: string };

export async function persistIngestBatch(
  batch: ClaimedIngestBatch,
  deps: IngestPersistDeps,
): Promise<PersistOutcome> {
  const inflated = inflateBody(batch.body, batch.contentEncoding);
  if (!inflated.ok) {
    return {
      kind: "failed",
      error:
        inflated.reason === "too_large"
          ? `oversized: Decompressed body too large (max ${MAX_INFLATED_BYTES} bytes).`
          : inflated.reason === "unsupported"
            ? "malformed: Unsupported Content-Encoding."
            : "malformed: Malformed compressed body.",
    };
  }
  const observers = {
    logError: deps.logError,
    logWarn: deps.logWarn,
    captureFailure: (error: unknown) =>
      deps.reportServerException(error, `project:${batch.projectId}`, {
        endpoint: `ingest-queue/${batch.signal}`,
        project_id: batch.projectId,
        batch_id: batch.id,
      }),
  };
  const organization = (await deps.getOrganizationByProjectId?.(batch.projectId)) ?? null;
  const transport: OtlpTransport = batch.contentType === "application/json" ? "json" : "protobuf";
  const gzipped = isGzipEncoding(batch.contentEncoding) ? batch.body : undefined;
  const firstTry = batch.attempts <= 1;
  const traces = firstTry ? deps.traces : { ...deps.traces, otlpRawCapture: undefined };
  const logs = firstTry ? deps.logs : { ...deps.logs, otlpRawCapture: undefined };

  if (batch.signal === "traces") {
    const decoded = decodeTraceExport(transport, inflated.bytes);
    if (!decoded.ok) return { kind: "failed", error: `${decoded.reason}: ${decoded.error}` };
    const meterTraces =
      organization && deps.traces.traceMetering
        ? await deps.traces.traceMetering.isMetered({ organization, projectId: batch.projectId })
        : false;
    const stored = await storeTraceExport(
      decoded.spans,
      {
        projectId: batch.projectId,
        organization,
        quotaOrgId: organization && deps.traces.incrementEventUsage ? organization.id : undefined,
        meterTraces,
        transport,
        body: inflated.bytes,
        gzipped,
      },
      traces,
      observers,
    );
    if (stored.ok) {
      const { ok: _ok, ...result } = stored;
      return { kind: "done", result };
    }
    if (stored.stage === "refused") return { kind: "done", result: { refused: true } };
    return { kind: "retry", error: "storage: the batch was not stored" };
  }

  if (batch.signal === "logs") {
    const decoded = decodeLogExport(transport, inflated.bytes);
    if (!decoded.ok) return { kind: "failed", error: `${decoded.reason}: ${decoded.error}` };
    const stored = await storeLogExport(
      decoded.records,
      {
        projectId: batch.projectId,
        organization,
        appendOnly: batch.context.appendOnly === true,
        transport,
        body: inflated.bytes,
        gzipped,
      },
      logs,
      observers,
    );
    if (stored.ok) {
      const { ok: _ok, ...result } = stored;
      return { kind: "done", result };
    }
    return { kind: "retry", error: "storage: the batch was not stored" };
  }

  const events = parseRuntimeEventsBody(inflated.bytes);
  if (!events) return { kind: "failed", error: "malformed: expected { events: [] }" };
  try {
    const stored = await storeRuntimeEvents(
      events,
      { projectId: batch.projectId, organization, appendOnly: batch.context.appendOnly === true },
      {
        ...deps.events,
        logError: deps.logError,
        reportServerException: deps.reportServerException,
      },
    );
    return {
      kind: "done",
      result: {
        accepted: stored.accepted,
        duplicates: stored.duplicates,
        rejected: stored.rejected.length,
      },
    };
  } catch (error) {
    deps.logError("runtime event insert failed", error, { project_id: batch.projectId });
    observers.captureFailure(error);
    return {
      kind: "retry",
      error: `storage: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
