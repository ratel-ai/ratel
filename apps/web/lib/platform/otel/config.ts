import { parseKeyPairsIntoRecord } from "@opentelemetry/core";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
} from "@opentelemetry/semantic-conventions";

/**
 * The platform's own traces and logs (self-telemetry, owned port of the upstream config). The
 * open-source edition exports only where an operator points it: both
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` must be set, or
 * nothing is exported and nothing leaves the process. There is no vendor default and no key is
 * ever forwarded to an endpoint it was not set for. `OTEL_SDK_DISABLED=true` is the emergency stop.
 */
type Environment = Readonly<Record<string, string | undefined>>;

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

export const SERVICE_NAME = "ratel-platform";

function sdkDisabled(environment: Environment): boolean {
  return environment.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true";
}

/** Whether this process exports its own telemetry: only when both signal endpoints are set. */
export function selfTelemetryEnabled(environment: Environment): boolean {
  if (sdkDisabled(environment)) return false;
  return (
    !!signalOverride(environment, "TRACES").endpoint &&
    !!signalOverride(environment, "LOGS").endpoint
  );
}

export function resolveSelfTelemetryConfig(
  environment: Environment,
  staticEnvironment: StaticTelemetryEnvironment,
): SelfTelemetryConfig | null {
  if (!selfTelemetryEnabled(environment)) return null;
  const traces = resolveSignalConfig(environment, "TRACES");
  const logs = resolveSignalConfig(environment, "LOGS");
  if (!traces || !logs) return null;

  return {
    resourceAttributes: {
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: staticEnvironment.deploymentEnvironment || "development",
    },
    tracesSamplerRatio: resolveTracesSamplerRatio(environment.OTEL_TRACES_SAMPLER_ARG),
    traces,
    logs,
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
export function unauthenticatedOverrideWarnings(environment: Environment): string[] {
  const warnings: string[] = [];
  for (const signal of ["TRACES", "LOGS"] as const) {
    const { endpointVar, headersVar, endpoint, rawHeaders } = signalOverride(environment, signal);
    if (endpoint && !rawHeaders) {
      warnings.push(
        `[otel] ${endpointVar} is set without ${headersVar}. The ${signal.toLowerCase()} exporter will send unauthenticated requests; set ${headersVar} if the collector needs credentials.`,
      );
    }
  }
  return warnings;
}

export function selfTelemetryConfigWarnings(
  environment: Environment,
  _staticEnvironment: StaticTelemetryEnvironment,
  config: SelfTelemetryConfig | null,
): string[] {
  if (sdkDisabled(environment)) return [];
  const traces = signalOverride(environment, "TRACES").endpoint;
  const logs = signalOverride(environment, "LOGS").endpoint;
  if (!traces && !logs) return [];

  const warnings = unauthenticatedOverrideWarnings(environment);
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

function resolveTracesSamplerRatio(value: string | undefined): number {
  const ratio = Number.parseFloat(value ?? "");
  return Number.isNaN(ratio) ? 1 : Math.min(1, Math.max(0, ratio));
}

function resolveSignalConfig(
  environment: Environment,
  signal: "TRACES" | "LOGS",
): OtlpSignalConfig | null {
  const { endpoint, rawHeaders } = signalOverride(environment, signal);
  if (!endpoint) return null;
  return { url: endpoint, headers: rawHeaders ? parseKeyPairsIntoRecord(rawHeaders) : {} };
}

function signalOverride(environment: Environment, signal: "TRACES" | "LOGS") {
  const endpointVar = `OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`;
  const headersVar = `OTEL_EXPORTER_OTLP_${signal}_HEADERS`;
  return {
    endpointVar,
    headersVar,
    endpoint: environment[endpointVar]?.trim(),
    rawHeaders: environment[headersVar]?.trim(),
  };
}

function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
