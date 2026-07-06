/**
 * `init()` — sugar over the standard OpenTelemetry JS SDK that wires an OTLP
 * `http/protobuf` span exporter at the Ratel endpoint. No custom transport, no
 * schema (ADR-0015, CONVENTIONS.md § init() surface). The `ratel.*` vocabulary and
 * the pure OTLP config resolution live in `@ratel-ai/telemetry`; this package adds
 * only the exporter wiring, so a caller already running the OTel SDK skips it and
 * takes just the constants.
 */

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { type InitOptions, resolveOtlpConfig } from "@ratel-ai/telemetry";

/** Handle returned by {@link init}; `shutdown()` flushes and stops the exporter. */
export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

/**
 * Wire an OTLP `http/protobuf` exporter + batch processor + `service.name`
 * resource over a `NodeTracerProvider`, register it globally, and return a
 * shutdown handle. Everything else is the untouched OTel SDK.
 *
 * `init()` registers and *owns* the global tracer provider, so it does not coexist
 * with an existing one (e.g. a customer's Langfuse). Coexistence today = emit
 * `ratel.*` via `@opentelemetry/api` + `@ratel-ai/telemetry` on the app's own
 * provider — no exporter package needed.
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
