import type { trackServerEvent as trackServerEventFn } from "@/lib/platform/telemetry";

/** The project's organization, as the edition resolves it: an id, a row with one, or none. */
type IngestFlagOrganizationInput = unknown;

import type { OtlpRawExportInput, OtlpRawStore } from "@/lib/ingest/otlp-raw/domain";
import type { LogError, LogWarn } from "@/lib/platform/logger";

/**
 * Raw OTLP capture at ingest (RC-405): keep the raw body of every accepted
 * export, within the daily byte cap. It fails open: a cap or store problem
 * never changes the ingest response. Logs carry the project id and sizes,
 * never the body.
 */
export interface OtlpRawCaptureDeps {
  store: OtlpRawStore;
}

export interface OtlpRawCaptureObservers {
  logError: LogError;
  logWarn: LogWarn;
  captureFailure: (error: unknown) => void;
  trackServerEvent?: typeof trackServerEventFn;
}

export async function captureOtlpRawExport(
  input: OtlpRawExportInput,
  organization: IngestFlagOrganizationInput,
  deps: OtlpRawCaptureDeps | undefined,
  observers: OtlpRawCaptureObservers,
): Promise<void> {
  if (!deps) return;
  try {
    const result = await deps.store.store(input);
    if (result.stored) return;
    const sizes = {
      project_id: input.projectId,
      signal: input.signal,
      reason: result.skipped,
      raw_bytes: result.rawBytes,
      stored_bytes: result.storedBytes,
      used_bytes: result.usedBytes,
      cap_bytes: result.capBytes,
    };
    observers.logWarn("otlp raw capture skipped", sizes);
    const organizationId =
      typeof organization === "string"
        ? organization
        : (organization as { id?: string } | null | undefined)?.id;
    await observers.trackServerEvent?.(
      "otlp_raw_capture_skipped",
      { projectId: input.projectId, ...(organizationId ? { orgId: organizationId } : {}) },
      sizes,
    );
  } catch (error) {
    observers.logError("otlp raw capture failed", error, {
      project_id: input.projectId,
      signal: input.signal,
      raw_bytes: input.body.byteLength,
    });
    observers.captureFailure(error);
  }
}
