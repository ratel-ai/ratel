import type { TraceMeteringPort } from "@/lib/contracts/trace-metering";
import { captureOtlpRawExport, type OtlpRawCaptureDeps } from "@/lib/ingest/otlp-raw/capture";
import type { LogError, LogWarn } from "@/lib/platform/logger";
import type { Organization } from "@/lib/platform/organizations";
import type { trackServerEvent as trackServerEventFn } from "@/lib/platform/telemetry";
import { decodeOtlp, OtlpDecodeError } from "./decode";
import type { OtlpTransport } from "./http";
import { type IngestLogDeps, logTracesIngested } from "./ingest-log";
import { type PersistSpansDeps, persistDecodedSpans } from "./ingest-spans";
import type { DecodedSpan } from "./types";

/**
 * The two halves of a trace export after the request's checks, shared by the inline route and the
 * ingest queue's worker (RTL-314), so both write through `persistDecodedSpans` and nothing else.
 */

/** Cap spans decoded from one export so a giant batch can't stall the request. */
export const MAX_SPANS = 5_000;

export type DecodeTracesResult =
  | { ok: true; spans: DecodedSpan[] }
  | { ok: false; status: 400 | 413; reason: "malformed" | "oversized"; error: string };

/** Decode an inflated OTLP trace export and bound its span count. */
export function decodeTraceExport(transport: OtlpTransport, bytes: Uint8Array): DecodeTracesResult {
  let spans: DecodedSpan[];
  try {
    spans = decodeOtlp(transport === "json" ? "application/json" : "application/x-protobuf", bytes);
  } catch (err) {
    if (err instanceof OtlpDecodeError) {
      return {
        ok: false,
        status: 400,
        reason: "malformed",
        error: `Malformed OTLP payload: ${err.message}`,
      };
    }
    throw err;
  }
  if (spans.length > MAX_SPANS) {
    return {
      ok: false,
      status: 413,
      reason: "oversized",
      error: `Too many spans in one export (max ${MAX_SPANS}).`,
    };
  }
  return { ok: true, spans };
}

/** What a queue that delivers an envelope again adds to a store (ADR-0010). Absent, the request stores. */
export interface RedeliveredContext {
  /** When the request was accepted: the clock for an item without a usable time. Absent, now. */
  receivedAt?: Date;
  /** Every failed write fails the store, because the same batch is stored again. */
  redelivers?: boolean;
  /** The raw capture's row id, so that a second delivery keeps no second copy. */
  captureId?: string;
}

export interface StoreTracesContext extends RedeliveredContext {
  projectId: string;
  organization: Organization | null;
  /** The organization to count stored events against; omitted, nothing is counted. */
  quotaOrgId?: string;
  /** `TraceMeteringPort.isMetered` for this organization, read by the caller. */
  meterTraces: boolean;
  transport: OtlpTransport;
  /** The inflated body, for the raw capture. */
  body: Uint8Array;
  /** The body as it arrived, when it arrived gzipped: the raw capture keeps it as is. */
  gzipped?: Uint8Array;
}

export interface StoreTracesDeps
  extends Omit<PersistSpansDeps, "logError" | "captureFailure" | "traceMetering"> {
  traceMetering?: Pick<TraceMeteringPort, "meterTraceBatch" | "releaseSpans">;
  /** The raw body store (RC-405); absent, nothing is kept. */
  otlpRawCapture?: OtlpRawCaptureDeps;
  /** Where the Datadog ingest lines go; absent, the app log and the cached project lookup. */
  ingestLog?: IngestLogDeps;
  trackServerEvent?: typeof trackServerEventFn;
}

export type StoreTracesResult =
  | {
      ok: true;
      accepted: number;
      calls: number;
      spans: number;
      refused?: number;
      /** Only of a redelivering store: the spans of dropped traces. */
      dropped?: number;
    }
  | { ok: false; stage: "refused" | "storage" };

/**
 * Persist decoded spans (`persistDecodedSpans`), log the ingest lines, and keep the raw body. The
 * raw capture runs after a stored export only, so garbage and retried failures are never kept;
 * nor is a partly refused one, whose body holds the refused spans. It fails open.
 */
export async function storeTraceExport(
  spans: DecodedSpan[],
  context: StoreTracesContext,
  deps: StoreTracesDeps,
  observers: { logError: LogError; logWarn: LogWarn; captureFailure: (error: unknown) => void },
): Promise<StoreTracesResult> {
  const persisted = await persistDecodedSpans(
    spans,
    {
      projectId: context.projectId,
      organization: context.organization,
      quotaOrgId: context.quotaOrgId,
      endpoint: "/v1/traces",
      foldIntentGraph: true,
      meterTraces: context.meterTraces,
      ...(context.receivedAt ? { receivedAt: context.receivedAt } : {}),
      ...(context.redelivers ? { redelivers: true } : {}),
    },
    { ...deps, logError: observers.logError, captureFailure: observers.captureFailure },
  );
  if (!persisted.ok)
    return { ok: false, stage: persisted.stage === "refused" ? "refused" : "storage" };
  await logTracesIngested(context.projectId, spans, persisted.rows, deps.ingestLog);
  if (!persisted.refused)
    await captureOtlpRawExport(
      {
        ...(context.captureId ? { id: context.captureId } : {}),
        projectId: context.projectId,
        signal: "traces",
        contentType: context.transport === "json" ? "application/json" : "application/x-protobuf",
        body: context.body,
        gzipped: context.gzipped,
        itemCount: spans.length,
        traceIds: [...new Set(spans.map((span) => span.traceId))],
      },
      context.organization,
      // An address is resolved and let go, so a body that holds one is not kept either.
      persisted.addressed ? undefined : deps.otlpRawCapture,
      {
        logError: observers.logError,
        logWarn: observers.logWarn,
        captureFailure: observers.captureFailure,
        trackServerEvent: deps.trackServerEvent,
      },
    );
  return {
    ok: true,
    accepted: persisted.accepted,
    calls: persisted.calls,
    spans: spans.length,
    ...(persisted.refused ? { refused: persisted.refused } : {}),
    ...(context.redelivers && persisted.dropped ? { dropped: persisted.dropped } : {}),
  };
}
