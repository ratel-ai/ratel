/**
 * `@ratel-ai/telemetry-otlp` — the `init()` OTLP exporter for Ratel telemetry.
 *
 * Turnkey OpenTelemetry SDK wiring (an OTLP `http/protobuf` exporter to `RATEL_URL`
 * or a caller-supplied endpoint) over the OTel-free `@ratel-ai/telemetry`
 * vocabulary. Split out (ADR-0015) so importing the constants never pulls the OTel
 * SDK. The OTLP config resolver and options are re-exported from
 * `@ratel-ai/telemetry` for convenience alongside `init()`.
 */

export {
  DEFAULT_SERVICE_NAME,
  ENDPOINT_ENV,
  type InitOptions,
  type ResolvedOtlpConfig,
  resolveOtlpConfig,
} from "@ratel-ai/telemetry";
export { init, type TelemetryHandle } from "./init.js";
