import { parseKeyPairsIntoRecord } from "@opentelemetry/core";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
} from "@opentelemetry/semantic-conventions";
import { type Config, getConfig } from "@/config";

/**
 * The platform's own traces and logs (self-telemetry, owned port of the upstream config). The
 * open-source edition exports only where an operator points it: both `otel.tracesEndpoint`
 * (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) and `otel.logsEndpoint` (OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)
 * must be set, or nothing is exported and nothing leaves the process. There is no vendor default
 * and no key is ever forwarded to an endpoint it was not set for. `otel.sdkDisabled`
 * (OTEL_SDK_DISABLED=true) is the emergency stop.
 */
type OtelConfig = Pick<Config, "otel">;

type OtlpSignalConfig = {
  url: string;
  headers: Record<string, string>;
};

export type StaticTelemetryEnvironment = {
  deploymentEnvironment?: string;
};

export type SelfTelemetryConfig = {
  resourceAttributes: {
    [ATTR_SERVICE_NAME]: string;
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: string;
  };
  tracesSamplerRatio: number;
  traces: OtlpSignalConfig;
  logs: OtlpSignalConfig;
};

/** Whether this process exports its own telemetry: only when both signal endpoints are set. */
export function selfTelemetryEnabled(config: OtelConfig = getConfig()): boolean {
  if (config.otel.sdkDisabled) return false;
  return !!signalOverride(config, "TRACES").endpoint && !!signalOverride(config, "LOGS").endpoint;
}

export function resolveSelfTelemetryConfig(
  config: OtelConfig,
  staticEnvironment: StaticTelemetryEnvironment,
): SelfTelemetryConfig | null {
  if (!selfTelemetryEnabled(config)) return null;
  const traces = resolveSignalConfig(config, "TRACES");
  const logs = resolveSignalConfig(config, "LOGS");
  if (!traces || !logs) return null;

  return {
    resourceAttributes: processResourceAttributes(config, staticEnvironment),
    tracesSamplerRatio: config.otel.tracesSamplerRatio,
    traces,
    logs,
  };
}

/**
 * The resource every exporter of this process starts from: its service (`otel.serviceName`,
 * OTEL_SERVICE_NAME, default `ratel-platform`; a deployment keeps its dashboards' name with it)
 * and deployment.
 */
export function processResourceAttributes(
  config: OtelConfig,
  staticEnvironment: StaticTelemetryEnvironment,
): SelfTelemetryConfig["resourceAttributes"] {
  return {
    [ATTR_SERVICE_NAME]: config.otel.serviceName,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: staticEnvironment.deploymentEnvironment || "development",
  };
}

/** Whether a request origin is one of the exporters' own, so their traffic is not re-traced. */
export function isTelemetryExportOrigin(
  requestOrigin: string,
  config: SelfTelemetryConfig,
): boolean {
  const origin = normalizedOrigin(requestOrigin);
  if (!origin) return false;
  return [config.traces.url, config.logs.url].some(
    (candidate) => normalizedOrigin(candidate) === origin,
  );
}

/**
 * A signal endpoint without matching headers yields an unauthenticated exporter most collectors
 * reject (401) with no local signal. The boot path logs these so the misconfiguration is visible.
 */
export function unauthenticatedOverrideWarnings(config: OtelConfig): string[] {
  const warnings: string[] = [];
  for (const signal of ["TRACES", "LOGS"] as const) {
    const { endpointVar, headersVar, endpoint, rawHeaders } = signalOverride(config, signal);
    if (endpoint && !rawHeaders) {
      warnings.push(
        `[otel] ${endpointVar} is set without ${headersVar}. The ${signal.toLowerCase()} exporter will send unauthenticated requests; set ${headersVar} if the collector needs credentials.`,
      );
    }
  }
  return warnings;
}

export function selfTelemetryConfigWarnings(
  settings: OtelConfig,
  _staticEnvironment: StaticTelemetryEnvironment,
  config: SelfTelemetryConfig | null,
): string[] {
  if (settings.otel.sdkDisabled) return [];
  const traces = signalOverride(settings, "TRACES").endpoint;
  const logs = signalOverride(settings, "LOGS").endpoint;
  if (!traces && !logs) return [];

  const warnings = unauthenticatedOverrideWarnings(settings);
  for (const [signal, endpoint] of [
    ["TRACES", traces],
    ["LOGS", logs],
  ] as const) {
    if (endpoint) continue;
    warnings.push(
      `[otel] The ${signal.toLowerCase()} exporter could not be resolved. Set both OTEL_EXPORTER_OTLP_TRACES_ENDPOINT and OTEL_EXPORTER_OTLP_LOGS_ENDPOINT (and their _HEADERS) to export the platform's own telemetry.`,
    );
  }
  if (!config) {
    warnings.push(
      "[otel] self-telemetry is partly configured but no exporter configuration could be resolved; telemetry will remain disabled.",
    );
  }
  return warnings;
}

function resolveSignalConfig(
  config: OtelConfig,
  signal: "TRACES" | "LOGS",
): OtlpSignalConfig | null {
  const { endpoint, rawHeaders } = signalOverride(config, signal);
  if (!endpoint) return null;
  return { url: endpoint, headers: rawHeaders ? parseKeyPairsIntoRecord(rawHeaders) : {} };
}

/** A signal's endpoint and headers, and the env variables a warning names for them. */
function signalOverride(config: OtelConfig, signal: "TRACES" | "LOGS") {
  const { tracesEndpoint, tracesHeaders, logsEndpoint, logsHeaders } = config.otel;
  return {
    endpointVar: `OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`,
    headersVar: `OTEL_EXPORTER_OTLP_${signal}_HEADERS`,
    endpoint: signal === "TRACES" ? tracesEndpoint : logsEndpoint,
    rawHeaders: signal === "TRACES" ? tracesHeaders : logsHeaders,
  };
}

function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
