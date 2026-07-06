/**
 * Pure OTLP config resolution + the content-capture gate for the `ratel.*`
 * telemetry vocabulary. No OpenTelemetry SDK import (ADR-0015): these helpers only
 * resolve endpoint/auth precedence and parse the capture env var, so they stay
 * weight-free for the three consumers that need the vocabulary without the
 * exporter — the SDK (emit side), the server (read side), and edge/serverless
 * emitters. The `init()` exporter that consumes `resolveOtlpConfig()` lives in the
 * separate `@ratel-ai/telemetry-otlp` package.
 */

import { CAPTURE_CONTENT_ENV } from "./index.js";

/** Env var whose value is the default OTLP endpoint when `{ apiKey }` is used. */
export const ENDPOINT_ENV = "RATEL_URL";

/** `service.name` used when the caller does not pass one. */
export const DEFAULT_SERVICE_NAME = "ratel";

/**
 * `init()` (in `@ratel-ai/telemetry-otlp`) accepts either `{ apiKey }` (endpoint
 * defaults to `RATEL_URL`, `Authorization: Bearer <apiKey>`) or `{ endpoint,
 * headers }` (custom endpoint / collector / dual-export). The two forms compose:
 * an explicit `endpoint` always wins over `RATEL_URL`, and `apiKey` adds the
 * Bearer header on top of any `headers`.
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

/** Resolved exporter configuration; the pure core of the OTLP exporter, exposed for testing. */
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
