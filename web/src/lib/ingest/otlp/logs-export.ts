import { type IngestLogDeps, logLogsIngested } from "@/lib/ingest/otlp/ingest-log";
import type { insertOtelLogs as insertOtelLogsFn } from "@/lib/ingest/otlp/queries";
import {
  type GenAiLogJoinDeps,
  rejoinStoredModelCalls,
} from "@/lib/ingest/otlp/semconv/gen-ai-log-join";
import { distinctSpanKeys } from "@/lib/ingest/otlp/semconv/gen-ai-logs";
import { captureOtlpRawExport, type OtlpRawCaptureDeps } from "@/lib/ingest/otlp-raw/capture";
import type { LogError, LogWarn } from "@/lib/platform/logger";
import type { Organization } from "@/lib/platform/organizations";
import type { trackServerEvent as trackServerEventFn } from "@/lib/platform/telemetry";
import { decodeOtlpLogs, OtlpDecodeError } from "./decode-logs";
import type { OtlpTransport } from "./http";
import { toOtelLogRows } from "./log-rows";
import type { RedeliveredContext } from "./traces-export";

/**
 * The two halves of a log export after the request's checks, shared by the inline route and the
 * ingest queue's worker (RTL-314).
 */

export const MAX_LOG_RECORDS = 5_000;

type LogRecords = ReturnType<typeof decodeOtlpLogs>;

export type DecodeLogsResult =
  | { ok: true; records: LogRecords }
  | { ok: false; status: 400 | 413; reason: "malformed" | "oversized"; error: string };

/** Decode an inflated OTLP log export and bound its record count. */
export function decodeLogExport(transport: OtlpTransport, bytes: Uint8Array): DecodeLogsResult {
  let records: LogRecords;
  try {
    records = decodeOtlpLogs(
      transport === "json" ? "application/json" : "application/x-protobuf",
      bytes,
    );
  } catch (error) {
    if (error instanceof OtlpDecodeError) {
      return {
        ok: false,
        status: 400,
        reason: "malformed",
        error: `Malformed OTLP payload: ${error.message}`,
      };
    }
    throw error;
  }
  if (records.length > MAX_LOG_RECORDS) {
    return {
      ok: false,
      status: 413,
      reason: "oversized",
      error: `Too many log records in one export (max ${MAX_LOG_RECORDS}).`,
    };
  }
  return { ok: true, records };
}

export interface StoreLogsContext extends RedeliveredContext {
  projectId: string;
  organization: Organization | null;
  /** The key only adds rows (RC-590): its records never rewrite catalog definitions or restate calls. */
  appendOnly: boolean;
  transport: OtlpTransport;
  body: Uint8Array;
  gzipped?: Uint8Array;
}

export interface StoreLogsDeps {
  insertOtelLogs: typeof insertOtelLogsFn;
  /** Restate a stored model call with its new `gen_ai` logs; absent, off. */
  genAiLogJoin?: GenAiLogJoinDeps;
  otlpRawCapture?: OtlpRawCaptureDeps;
  ingestLog?: IngestLogDeps;
  trackServerEvent?: typeof trackServerEventFn;
}

export type StoreLogsResult =
  | { ok: true; accepted: number; records: number; dropped: number }
  | { ok: false; stage: "storage" };

/** Store decoded records, join their model calls, keep the raw body and log the ingest line. */
export async function storeLogExport(
  records: LogRecords,
  context: StoreLogsContext,
  deps: StoreLogsDeps,
  observers: { logError: LogError; logWarn: LogWarn; captureFailure: (error: unknown) => void },
): Promise<StoreLogsResult> {
  const { projectId, organization, appendOnly, receivedAt, redelivers } = context;
  const { rows, dropped } = toOtelLogRows(projectId, records, receivedAt);
  const stored = appendOnly ? rows.map(({ catalogDefinition: _definition, ...row }) => row) : rows;
  let accepted = 0;
  if (stored.length > 0) {
    try {
      ({ accepted } = redelivers
        ? await deps.insertOtelLogs(projectId, stored, undefined, { redelivers })
        : await deps.insertOtelLogs(projectId, stored));
    } catch (error) {
      observers.logError("log record insert failed", error, { project_id: projectId });
      observers.captureFailure(error);
      return { ok: false, stage: "storage" };
    }
  }

  // Spans before logs: restate the model calls these records belong to.
  // Fails open: the logs are stored, and a retry of the export joins again. A redelivered one is
  // delivered again for it.
  if (deps.genAiLogJoin && !appendOnly) {
    const keys = distinctSpanKeys(rows.filter((row) => row.eventName.startsWith("gen_ai.")));
    try {
      await rejoinStoredModelCalls(projectId, organization, keys, {
        ...deps.genAiLogJoin,
        captureFailure: observers.captureFailure,
        ...(receivedAt ? { receivedAt } : {}),
      });
    } catch (error) {
      observers.logError("gen_ai log join failed", error, { project_id: projectId });
      observers.captureFailure(error);
      if (redelivers) return { ok: false, stage: "storage" };
    }
  }

  // Raw capture after a stored export; fails open, never changes the response.
  await captureOtlpRawExport(
    {
      ...(context.captureId ? { id: context.captureId } : {}),
      projectId,
      signal: "logs",
      contentType: context.transport === "json" ? "application/json" : "application/x-protobuf",
      body: context.body,
      gzipped: context.gzipped,
      itemCount: records.length,
      traceIds: [...new Set(records.flatMap((record) => (record.traceId ? [record.traceId] : [])))],
    },
    organization,
    deps.otlpRawCapture,
    {
      logError: observers.logError,
      logWarn: observers.logWarn,
      captureFailure: observers.captureFailure,
      trackServerEvent: deps.trackServerEvent,
    },
  );
  await logLogsIngested(projectId, { records: records.length, accepted, dropped }, deps.ingestLog);
  return { ok: true, accepted, records: records.length, dropped };
}
