/**
 * `startTelemetry()` — the turnkey greenfield path: sugar over the standard OpenTelemetry JS
 * SDK that wires an OTLP `http/protobuf` span exporter at the Ratel endpoint and registers a
 * provider Ratel owns. Host span processors passed via `spanProcessors` compose onto that same
 * provider, so a single call dual-exports (e.g. to Langfuse) without a foreign provider. No
 * custom transport, no schema (ADR-0007, CONVENTIONS.md § init() surface). The `ratel.*`
 * vocabulary and the pure OTLP config resolution live in `@ratel-ai/telemetry`; this package
 * adds only the exporter wiring. `init` is the back-compat alias for the pre-composition name.
 *
 * When a partner already runs their own OTel provider (Langfuse, the Vercel AI SDK, ...),
 * `startTelemetry` cannot take over the global provider — it throws, pointing at
 * {@link ratelSpanProcessor}, which composes onto the existing provider instead.
 */

import { ProxyTracerProvider, trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { type InitOptions, resolveOtlpConfig } from "@ratel-ai/telemetry";
import { ratelSpanProcessor, type SpanFilter } from "./processor.js";

/**
 * Handle returned by {@link startTelemetry}. `forceFlush()` drains every registered span
 * processor's pending spans to its exporter (serverless/jobs); `shutdown()` flushes and stops.
 */
export interface TelemetryHandle {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Options for the turnkey {@link startTelemetry} path. */
export interface TelemetryInitOptions extends InitOptions {
  /** On first setup, set false to skip configuration and provider registration. */
  enabled?: boolean;
  /** Override the default filter; `startTelemetry` forwards every span when omitted. */
  spanFilter?: SpanFilter;
  /**
   * Host OTel span processors (e.g. `new LangfuseSpanProcessor()`) to register alongside
   * Ratel's on the owned provider. Every processor sees the same span stream; each does its
   * own filtering. This is the composition seam for dual-export without a foreign provider.
   */
  spanProcessors?: SpanProcessor[];
}

const NOOP_HANDLE: TelemetryHandle = { forceFlush: async () => {}, shutdown: async () => {} };
const ACCEPT_ALL_SPANS: SpanFilter = () => true;
const RATEL_PROVIDER_HANDLE = Symbol.for("@ratel-ai/telemetry-otlp/provider-handle");
/** Marks a Ratel-owned provider whose handle has been shut down (its exporter is dead). */
const RATEL_PROVIDER_SHUTDOWN = Symbol.for("@ratel-ai/telemetry-otlp/provider-shutdown");
const NOOP_GLOBAL_PROVIDER = new ProxyTracerProvider().getDelegate();

/**
 * Wire an OTLP `http/protobuf` exporter + batch processor + `service.name` resource over
 * a `NodeTracerProvider`, register it as the global provider, and return a handle exposing
 * `forceFlush()` (drain every registered processor) and `shutdown()`. Everything else is the
 * untouched OTel SDK.
 *
 * `startTelemetry` owns the global provider, so it exports every span by default (unlike
 * {@link ratelSpanProcessor}, whose default `gen_ai.*`/`ratel.*` filter exists for sharing a
 * provider). Pass `spanFilter` to narrow the Ratel side, `spanProcessors` to fan the same span
 * stream out to host processors (Langfuse, ...), or `enabled: false` for a no-op handle on
 * first setup. Repeated calls return the existing handle when Ratel already owns the active
 * provider—even if a later caller is disabled—so shutting that handle down stops export for
 * every caller. It throws with a pointer to {@link ratelSpanProcessor} when a foreign provider
 * is registered. Shutdown is terminal: after `handle.shutdown()`, a later call throws rather
 * than hand back the dead handle (call `trace.disable()` first to re-initialize).
 */
export function startTelemetry(opts: TelemetryInitOptions = {}): TelemetryHandle {
  const activeProvider = activeGlobalProvider();
  const existingHandle = ratelOwnedHandle(activeProvider);
  if (existingHandle) {
    if (providerIsShutDown(activeProvider)) throw alreadyShutDownError();
    return existingHandle;
  }

  const {
    enabled = true,
    spanFilter = ACCEPT_ALL_SPANS,
    spanProcessors = [],
    ...configOpts
  } = opts;
  if (!enabled) return NOOP_HANDLE;
  if (activeProvider !== NOOP_GLOBAL_PROVIDER) throw foreignProviderError();

  // Resolve first so a missing endpoint throws before we build/register anything.
  const { serviceName } = resolveOtlpConfig(configOpts);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    // Ratel's processor plus any host processors, all on one provider: every finished span
    // fans out to all of them, each applying its own filter.
    spanProcessors: [ratelSpanProcessor({ ...configOpts, spanFilter }), ...spanProcessors],
  });
  const handle: TelemetryHandle = {
    // Delegate to the provider so every registered processor (Ratel's + hosts') drains.
    forceFlush: () => provider.forceFlush(),
    shutdown: async () => {
      try {
        await provider.shutdown();
      } finally {
        // Flag the dead provider so a later startTelemetry() fails loud instead of returning it.
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

/** Back-compat alias for {@link startTelemetry}, the pre-composition name. */
export const init = startTelemetry;

function providerIsShutDown(provider: unknown): boolean {
  if ((typeof provider !== "object" && typeof provider !== "function") || provider === null) {
    return false;
  }
  return Reflect.get(provider, RATEL_PROVIDER_SHUTDOWN) === true;
}

function foreignProviderError(): Error {
  return new Error(
    "ratel telemetry startTelemetry(): an OpenTelemetry TracerProvider is already registered " +
      "globally, so startTelemetry() (the turnkey path that owns the provider) cannot take over. " +
      "To send Ratel telemetry alongside an existing provider (e.g. Langfuse + the Vercel AI SDK), " +
      "add ratelSpanProcessor({ apiKey }) to that provider's spanProcessors instead.",
  );
}

function alreadyShutDownError(): Error {
  return new Error(
    "ratel telemetry startTelemetry(): telemetry was already shut down in this process. The " +
      "global OpenTelemetry tracer provider is registered once, so a later startTelemetry() " +
      "cannot re-take it. Call trace.disable() first if you must re-initialize (e.g. in tests).",
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
