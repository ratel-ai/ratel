import { getLogger, type LogError, type LogWarn } from "@/lib/platform/logger";
import type { trackServerEvent as trackServerEventFn } from "@/lib/platform/telemetry";

export type IngestEndpoint = "/v1/traces" | "/v1/logs";
export type IngestRejectionReason =
  | "invalid_key"
  | "malformed"
  | "oversized"
  | "quota"
  | "unsupported_media"
  | "storage"
  | "unavailable";

export interface IngestObservabilityDeps {
  trackServerEvent?: typeof trackServerEventFn;
  shouldSampleSuccess?: () => boolean;
  shouldSampleRejection?: () => boolean;
  logError?: LogError;
  logWarn?: LogWarn;
  now?: () => Date;
}

interface IngestObservation {
  endpoint: IngestEndpoint;
  startedAt: number;
  deps: IngestObservabilityDeps;
  projectId?: string;
  organizationId?: string;
}

type IngestCounts = Record<string, number>;

/** OBS_INGEST_SUCCESS_SAMPLE_RATE is a one-in-N denominator; default 100. */
const DEFAULT_SUCCESS_SAMPLE_RATE = 100;

/** OBS_INGEST_REJECTION_SAMPLE_RATE is a one-in-N denominator; default 100. */
const DEFAULT_REJECTION_SAMPLE_RATE = 100;
const logger = getLogger("otlp/ingest-observability");
const defaultLogWarn: LogWarn = (message, fields) => logger.warn(fields, message);

export async function rejectIngestRequest(
  response: Response,
  reason: IngestRejectionReason,
  observation: IngestObservation,
): Promise<Response> {
  // A wedged or unauthenticated client can spray rejections at unbounded volume, so
  // the telemetry event is sampled. The per-request request log (withRequestLog) and
  // the warning below still records every rejection, so the reason taxonomy is
  // never lost — only the telemetry event rate is capped.
  const sampled = observation.deps.shouldSampleRejection?.() ?? shouldSampleIngestRejection();
  const properties = {
    endpoint: observation.endpoint,
    outcome: "rejected",
    reason,
    status: response.status,
    duration_ms: durationMs(observation),
  };
  (observation.deps.logWarn ?? defaultLogWarn)("request rejected", properties);
  if (sampled) {
    await trackIngestEvent("otlp_ingest_request", properties, observation);
  }
  return response;
}

export async function trackAcceptedIngestRequest(
  counts: IngestCounts,
  observation: IngestObservation,
): Promise<void> {
  const { deps } = observation;
  if (!deps.trackServerEvent || !(deps.shouldSampleSuccess?.() ?? shouldSampleIngestSuccess())) {
    return;
  }

  await trackIngestEvent(
    "otlp_ingest_request",
    {
      endpoint: observation.endpoint,
      outcome: "accepted",
      status: 202,
      duration_ms: durationMs(observation),
      ...counts,
    },
    observation,
  );
}

export async function trackFirstTraceReceived(
  observation: IngestObservation & { projectId: string },
): Promise<void> {
  if (!observation.deps.trackServerEvent) return;

  await trackIngestEvent(
    "first_trace_received",
    { endpoint: "/v1/traces", duration_ms: durationMs(observation) },
    observation,
  );
}

export function shouldSampleIngestSuccess(
  random: () => number = Math.random,
  configuredRate = process.env.OBS_INGEST_SUCCESS_SAMPLE_RATE,
): boolean {
  return sampleOneInN(configuredRate, DEFAULT_SUCCESS_SAMPLE_RATE, random);
}

export function shouldSampleIngestRejection(
  random: () => number = Math.random,
  configuredRate = process.env.OBS_INGEST_REJECTION_SAMPLE_RATE,
): boolean {
  return sampleOneInN(configuredRate, DEFAULT_REJECTION_SAMPLE_RATE, random);
}

/** One-in-N sampling gate: parse the denominator, treating <=0 (or unparseable) as off. */
function sampleOneInN(
  configuredRate: string | undefined,
  defaultRate: number,
  random: () => number,
): boolean {
  const parsed = Number.parseInt(configuredRate ?? "", 10);
  const rate = Number.isFinite(parsed) ? parsed : defaultRate;
  if (rate <= 0) return false;
  return random() < 1 / rate;
}

async function trackIngestEvent(
  event: "otlp_ingest_request" | "first_trace_received",
  properties: Record<string, unknown>,
  observation: IngestObservation,
): Promise<void> {
  const { deps, projectId, organizationId } = observation;
  if (!deps.trackServerEvent) return;
  await deps.trackServerEvent(
    event,
    projectId
      ? {
          projectId,
          ...(organizationId ? { orgId: organizationId } : {}),
        }
      : { distinctId: "otlp:anonymous" },
    properties,
  );
}

function durationMs(observation: IngestObservation): number {
  return Math.max(0, (observation.deps.now?.() ?? new Date()).getTime() - observation.startedAt);
}
