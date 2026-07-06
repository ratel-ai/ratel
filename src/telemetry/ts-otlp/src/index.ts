/**
 * `@ratel-ai/telemetry-otlp` — the OTLP exporter surface for Ratel telemetry.
 *
 * Turnkey OpenTelemetry SDK wiring over the OTel-free `@ratel-ai/telemetry`
 * vocabulary. Split out (ADR-0015) so importing the constants never pulls the OTel
 * SDK. Two entry points: `init()` for a greenfield app where Ratel owns the provider,
 * and `ratelSpanProcessor()` / `ratelTraceExporter()` to compose Ratel onto a provider
 * a partner already owns (Langfuse, the Vercel AI SDK, ...). The OTLP config resolver
 * and options are re-exported from `@ratel-ai/telemetry` for convenience.
 */

export {
  DEFAULT_SERVICE_NAME,
  ENDPOINT_ENV,
  type InitOptions,
  type ResolvedOtlpConfig,
  resolveOtlpConfig,
} from "@ratel-ai/telemetry";
export { init, type TelemetryHandle } from "./init.js";
export {
  type RatelSpanProcessorOptions,
  ratelSignalFilter,
  ratelSpanProcessor,
  ratelTraceExporter,
  type SpanFilter,
} from "./processor.js";
