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
import { ratelSpanProcessor, type SpanFilter } from "./processor.js";

/** Handle returned by {@link init}; `shutdown()` flushes and stops the exporter. */
export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

/** Options for the turnkey {@link init} path. */
export interface TelemetryInitOptions extends InitOptions {
  /** On first setup, set false to skip configuration and provider registration. */
  enabled?: boolean;
  /** Override the default filter; `init()` forwards every span when omitted. */
  spanFilter?: SpanFilter;
}

const NOOP_HANDLE: TelemetryHandle = { shutdown: async () => {} };
const ACCEPT_ALL_SPANS: SpanFilter = () => true;
const RATEL_PROVIDER_HANDLE = Symbol.for("@ratel-ai/telemetry-otlp/provider-handle");
/** Marks a Ratel-owned provider whose handle has been shut down (its exporter is dead). */
const RATEL_PROVIDER_SHUTDOWN = Symbol.for("@ratel-ai/telemetry-otlp/provider-shutdown");
const NOOP_GLOBAL_PROVIDER = new ProxyTracerProvider().getDelegate();

/**
 * Wire an OTLP `http/protobuf` exporter + batch processor + `service.name` resource over
 * a `NodeTracerProvider`, register it as the global provider, and return a shutdown handle.
 * Everything else is the untouched OTel SDK.
 *
 * `init()` owns the global provider, so it exports every span by default (unlike
 * {@link ratelSpanProcessor}, whose default `gen_ai.*`/`ratel.*` filter exists for sharing a
 * provider). Pass `spanFilter` to narrow that set, or `enabled: false` for a no-op handle on
 * first setup. Repeated calls return the existing handle when Ratel already owns the active
 * provider—even if a later caller is disabled—so shutting that handle down stops export for
 * every caller. It throws with a pointer to {@link ratelSpanProcessor} when a foreign provider
 * is registered. Shutdown is terminal: after `handle.shutdown()`, a later `init()` throws
 * rather than hand back the dead handle (call `trace.disable()` first to re-initialize).
 */
export function init(opts: TelemetryInitOptions = {}): TelemetryHandle {
  const activeProvider = activeGlobalProvider();
  const existingHandle = ratelOwnedHandle(activeProvider);
  if (existingHandle) {
    if (providerIsShutDown(activeProvider)) throw alreadyShutDownError();
    return existingHandle;
  }

  const { enabled = true, spanFilter = ACCEPT_ALL_SPANS, ...configOpts } = opts;
  if (!enabled) return NOOP_HANDLE;
  if (activeProvider !== NOOP_GLOBAL_PROVIDER) throw foreignProviderError();

  // Resolve first so a missing endpoint throws before we build/register anything.
  const { serviceName } = resolveOtlpConfig(configOpts);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [ratelSpanProcessor({ ...configOpts, spanFilter })],
  });
  const handle: TelemetryHandle = {
    shutdown: async () => {
      try {
        await provider.shutdown();
      } finally {
        // Flag the dead provider so a later init() fails loud instead of returning this handle.
        Object.defineProperty(provider, RATEL_PROVIDER_SHUTDOWN, {
          value: true,
          configurable: true,
        });
      }
    },
  };
  Object.defineProperty(provider, RATEL_PROVIDER_HANDLE, { value: handle });
  provider.register();
  const winner = activeGlobalProvider();
  if (winner !== provider) {
    // Lost a registration race. If Ratel already owns the winner, honor idempotence and
    // return its handle; only a truly foreign winner is a composition error.
    void provider.shutdown();
    const winnerHandle = ratelOwnedHandle(winner);
    if (winnerHandle) return winnerHandle;
    throw foreignProviderError();
  }
  return handle;
}

function providerIsShutDown(provider: unknown): boolean {
  if ((typeof provider !== "object" && typeof provider !== "function") || provider === null) {
    return false;
  }
  return Reflect.get(provider, RATEL_PROVIDER_SHUTDOWN) === true;
}

function foreignProviderError(): Error {
  return new Error(
    "ratel telemetry init(): an OpenTelemetry TracerProvider is already registered globally, " +
      "so init() (the turnkey path that owns the provider) cannot take over. To send Ratel " +
      "telemetry alongside an existing provider (e.g. Langfuse + the Vercel AI SDK), add " +
      "ratelSpanProcessor({ apiKey }) to that provider's spanProcessors instead of calling init().",
  );
}

function alreadyShutDownError(): Error {
  return new Error(
    "ratel telemetry init(): telemetry was already shut down in this process. The global " +
      "OpenTelemetry tracer provider is registered once, so a later init() cannot re-take it. " +
      "Call trace.disable() before init() if you must re-initialize (e.g. in tests).",
  );
}

function ratelOwnedHandle(provider: unknown): TelemetryHandle | undefined {
  if ((typeof provider !== "object" && typeof provider !== "function") || provider === null) {
    return undefined;
  }
  const handle: unknown = Reflect.get(provider, RATEL_PROVIDER_HANDLE);
  if (
    (typeof handle !== "object" && typeof handle !== "function") ||
    handle === null ||
    typeof Reflect.get(handle, "shutdown") !== "function"
  ) {
    return undefined;
  }
  return handle as TelemetryHandle;
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
