import { getConfig } from "@/config";

/**
 * The names both editions share for Ratel's own model calls as telemetry (ratel-cloud #410): the
 * tracer whose spans the self-telemetry export selects, and the project those calls must not be
 * traced for. A contract so the edition's model-call sites (`ee/`) and the core's export
 * (`lib/platform/otel/ratel-export.ts`) agree without importing each other.
 */

/** The tracer `trackModelCall` and agent runs (lib/platform/agent-run.ts) make their spans with; its scope is what the export selects on. */
export const MODEL_CALL_TRACER = "ratel-cloud/model-calls";

/**
 * The project the self-telemetry key writes to, if one is named: `selfTelemetry.projectId`
 * (RATEL_SELF_TELEMETRY_PROJECT_ID, `web/src/config.ts`). Model calls made while analysing that
 * project are not exported: they would feed its own labelling and intent jobs, and those jobs'
 * calls would come back again.
 */
export function selfTelemetryProjectId(): string | undefined {
  return getConfig().selfTelemetry.projectId;
}
