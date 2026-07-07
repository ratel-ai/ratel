/**
 * `init()` — the turnkey greenfield path: sugar over the standard OpenTelemetry JS SDK
 * that wires an OTLP `http/protobuf` span exporter at the Ratel endpoint and registers a
 * provider Ratel owns. No custom transport, no schema (ADR-0007, CONVENTIONS.md § init()
 * surface). The `ratel.*` vocabulary and the pure OTLP config resolution live in
 * `@ratel-ai/telemetry`; this package adds only the exporter wiring.
 *
 * When a partner already runs their own OTel provider (Langfuse, the Vercel AI SDK, ...),
 * `init()` cannot take over the global provider — it throws, pointing at
 * {@link ratelSpanProcessor}, which composes onto the existing provider instead.
 */

import { ProxyTracerProvider, trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { type InitOptions, resolveOtlpConfig } from "@ratel-ai/telemetry";
import { ratelSpanProcessor } from "./processor.js";

/** Handle returned by {@link init}; `shutdown()` flushes and stops the exporter. */
export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

/**
 * Wire an OTLP `http/protobuf` exporter + batch processor + `service.name` resource over
 * a `NodeTracerProvider`, register it as the global provider, and return a shutdown handle.
 * Everything else is the untouched OTel SDK.
 *
 * `init()` owns the global provider, so it exports every span (unlike {@link ratelSpanProcessor},
 * whose default `gen_ai.*`/`ratel.*` filter exists for sharing a provider). It throws with a
 * pointer to {@link ratelSpanProcessor} — rather than silently no-op'ing — if a provider is
 * already registered globally.
 */
export function init(opts: InitOptions = {}): TelemetryHandle {
  // Resolve first so a missing endpoint throws before we build/register anything.
  const { serviceName } = resolveOtlpConfig(opts);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [ratelSpanProcessor({ ...opts, spanFilter: () => true })],
  });
  provider.register();
  if (activeGlobalProvider() !== provider) {
    void provider.shutdown();
    throw new Error(
      "ratel telemetry init(): an OpenTelemetry TracerProvider is already registered globally, " +
        "so init() (the turnkey path that owns the provider) cannot take over. To send Ratel " +
        "telemetry alongside an existing provider (e.g. Langfuse + the Vercel AI SDK), add " +
        "ratelSpanProcessor({ apiKey }) to that provider's spanProcessors instead of calling init().",
    );
  }
  return { shutdown: () => provider.shutdown() };
}

/**
 * The real provider currently backing the global tracer API — the delegate behind the
 * always-present `ProxyTracerProvider`. After `provider.register()`, this equals our
 * provider iff the registration took (no other provider was already registered).
 */
function activeGlobalProvider(): unknown {
  const provider = trace.getTracerProvider();
  return provider instanceof ProxyTracerProvider ? provider.getDelegate() : provider;
}
