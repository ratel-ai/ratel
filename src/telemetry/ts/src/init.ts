/**
 * `init()` — sugar over the standard OpenTelemetry JS SDK that wires an OTLP
 * `http/protobuf` span exporter at the Ratel endpoint. No custom transport, no
 * schema (ADR-0015, CONVENTIONS.md § init() surface). A caller who already runs
 * the OTel SDK skips this entirely and just takes the `ratel.*` constants.
 */

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { CAPTURE_CONTENT_ENV } from "./index.js";

/** Env var whose value is the default OTLP endpoint when `{ apiKey }` is used. */
export const ENDPOINT_ENV = "RATEL_URL";

/** `service.name` used when the caller does not pass one. */
export const DEFAULT_SERVICE_NAME = "ratel";

/**
 * `init()` accepts either `{ apiKey }` (endpoint defaults to `RATEL_URL`,
 * `Authorization: Bearer <apiKey>`) or `{ endpoint, headers }` (custom
 * endpoint / collector / dual-export). The two forms compose: an explicit
 * `endpoint` always wins over `RATEL_URL`, and `apiKey` adds the Bearer header
 * on top of any `headers`.
 */
export interface InitOptions {
  /** `service.name` resource attribute. Defaults to {@link DEFAULT_SERVICE_NAME}. */
  serviceName?: string;
  /** Ratel API key; sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Full OTLP traces URL (incl. `/v1/traces`). Defaults to `RATEL_URL`. */
  endpoint?: string;
  /** Extra headers merged onto the request (before the `apiKey` Bearer header). */
  headers?: Record<string, string>;
}

/** Handle returned by {@link init}; `shutdown()` flushes and stops the exporter. */
export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

/** Resolved exporter configuration; the pure core of {@link init}, exposed for testing. */
export interface ResolvedOtlpConfig {
  url: string;
  headers: Record<string, string>;
  serviceName: string;
}

/**
 * Resolve {@link InitOptions} into concrete exporter config. Pure and
 * env-injectable so the endpoint/auth precedence is testable without a network.
 */
export function resolveOtlpConfig(
  opts: InitOptions = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedOtlpConfig {
  const url = opts.endpoint ?? env[ENDPOINT_ENV];
  if (!url) {
    throw new Error(
      `ratel telemetry init: no endpoint. Pass { endpoint } or set ${ENDPOINT_ENV} (use { apiKey } for Bearer auth).`,
    );
  }
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }
  return { url, headers, serviceName: opts.serviceName ?? DEFAULT_SERVICE_NAME };
}

/**
 * Wire an OTLP `http/protobuf` exporter + batch processor + `service.name`
 * resource over a `NodeTracerProvider`, register it globally, and return a
 * shutdown handle. Everything else is the untouched OTel SDK.
 */
export function init(opts: InitOptions = {}): TelemetryHandle {
  const { url, headers, serviceName } = resolveOtlpConfig(opts);
  const exporter = new OTLPTraceExporter({ url, headers });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  provider.register();
  return { shutdown: () => provider.shutdown() };
}

/**
 * Message/tool content capture modes for
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` (CONVENTIONS.md § Capture
 * gating). Default off.
 */
export const ContentCapture = {
  NoContent: "NO_CONTENT",
  SpanOnly: "SPAN_ONLY",
  EventOnly: "EVENT_ONLY",
  SpanAndEvent: "SPAN_AND_EVENT",
} as const;
export type ContentCapture = (typeof ContentCapture)[keyof typeof ContentCapture];

/**
 * Parse the ecosystem content-capture gate. Default {@link ContentCapture.NoContent}
 * when unset/empty/unrecognized. The legacy boolean form maps `true` to full
 * capture ({@link ContentCapture.SpanAndEvent}) and `false` to none.
 */
export function contentCaptureMode(
  env: Record<string, string | undefined> = process.env,
): ContentCapture {
  const raw = env[CAPTURE_CONTENT_ENV];
  if (raw == null || raw.trim() === "") {
    return ContentCapture.NoContent;
  }
  switch (raw.trim().toUpperCase()) {
    case "NO_CONTENT":
      return ContentCapture.NoContent;
    case "SPAN_ONLY":
      return ContentCapture.SpanOnly;
    case "EVENT_ONLY":
      return ContentCapture.EventOnly;
    case "SPAN_AND_EVENT":
      return ContentCapture.SpanAndEvent;
    case "TRUE":
    case "1":
      return ContentCapture.SpanAndEvent;
    default:
      return ContentCapture.NoContent;
  }
}
