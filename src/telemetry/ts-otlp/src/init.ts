/**
 * `startTelemetry()` — the turnkey greenfield path: sugar over the standard OpenTelemetry JS SDK
 * that wires OTLP `http/protobuf` trace and Logs exporters at the Ratel endpoints and
 * registers providers Ratel owns. No custom transport (ADR-0007, CONVENTIONS.md § init()
 * surface). The `ratel.*` vocabulary and the pure OTLP config resolution live in
 * `@ratel-ai/telemetry`; this package adds only the exporter wiring. `init` remains the
 * back-compat alias.
 *
 * When a partner already runs their own OTel provider (Langfuse, the Vercel AI SDK, ...),
 * `init()` cannot take over the global providers — it throws, pointing at
 * {@link ratelSpanProcessor} and {@link ratelLogRecordProcessor}, which compose instead.
 */

import { ProxyTracerProvider, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { LoggerProvider, type LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { type InitOptions, resolveOtlpConfig } from "@ratel-ai/telemetry";
import {
  type LogFilter,
  ratelLogRecordProcessor,
  ratelSpanProcessor,
  type SpanFilter,
} from "./processor.js";

/** Handle returned by {@link startTelemetry}; controls both owned providers. */
export interface TelemetryHandle {
  /** Flush every trace and Logs processor without shutting either provider down. */
  forceFlush(): Promise<void>;
  /** Flush and stop both providers. */
  shutdown(): Promise<void>;
}

/** Options for the turnkey {@link startTelemetry} path. */
export interface TelemetryInitOptions extends InitOptions {
  /** On first setup, set false to skip configuration and provider registration. */
  enabled?: boolean;
  /** Override the default filter; `init()` forwards every span when omitted. */
  spanFilter?: SpanFilter;
  /** Override the default filter; `init()` forwards every EventRecord when omitted. */
  logFilter?: LogFilter;
  /** Host span processors registered alongside Ratel's on the owned tracer provider. */
  spanProcessors?: SpanProcessor[];
  /** Host Logs processors registered alongside Ratel's on the owned logger provider. */
  logRecordProcessors?: LogRecordProcessor[];
}

const NOOP_HANDLE: TelemetryHandle = {
  forceFlush: async () => {},
  shutdown: async () => {},
};
const ACCEPT_ALL_SPANS: SpanFilter = () => true;
const ACCEPT_ALL_LOGS: LogFilter = () => true;
const RATEL_PROVIDER_HANDLE = Symbol.for("@ratel-ai/telemetry-otlp/provider-handle");
const RATEL_LOGGER_PROVIDER_HANDLE = Symbol.for("@ratel-ai/telemetry-otlp/logger-provider-handle");
/** Marks a Ratel-owned provider whose handle has been shut down (its exporter is dead). */
const RATEL_PROVIDER_SHUTDOWN = Symbol.for("@ratel-ai/telemetry-otlp/provider-shutdown");
const NOOP_GLOBAL_PROVIDER = new ProxyTracerProvider().getDelegate();

/**
 * Wire OTLP `http/protobuf` exporters + batch processors + one `service.name` resource over
 * tracer and logger providers, register them globally, and return a shared shutdown handle.
 *
 * `startTelemetry()` owns both global providers, so it exports every span and EventRecord by default
 * (the composable processors use signal filters when sharing host providers). Pass
 * `spanFilter` / `logFilter` to narrow those sets, add host processors through
 * `spanProcessors` / `logRecordProcessors`, or use `enabled: false` for a no-op handle on first
 * setup. Repeated calls return the existing handle only while both Ratel-owned providers remain
 * active. Shutdown is terminal: after `handle.shutdown()`, a later call throws rather than hand
 * back the dead handle (disable both global providers to re-initialize).
 */
export function startTelemetry(opts: TelemetryInitOptions = {}): TelemetryHandle {
  const activeProvider = activeGlobalProvider();
  const activeLoggerProvider = logs.getLoggerProvider();
  const existingHandle = ratelOwnedHandle(activeProvider);
  if (existingHandle) {
    if (providerIsShutDown(activeProvider)) throw alreadyShutDownError();
    if (ratelOwnedLoggerHandle(activeLoggerProvider) !== existingHandle) {
      throw providerPairLostError();
    }
    return existingHandle;
  }

  const {
    enabled = true,
    spanFilter = ACCEPT_ALL_SPANS,
    logFilter = ACCEPT_ALL_LOGS,
    spanProcessors = [],
    logRecordProcessors = [],
    ...configOpts
  } = opts;
  if (!enabled) return NOOP_HANDLE;
  if (activeProvider !== NOOP_GLOBAL_PROVIDER) throw foreignProviderError();
  if (!isDefaultLoggerProvider(activeLoggerProvider)) throw foreignProviderError();

  // Resolve first so a missing endpoint throws before we build/register anything.
  const { serviceName } = resolveOtlpConfig(configOpts);
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });
  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [ratelSpanProcessor({ ...configOpts, spanFilter }), ...spanProcessors],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [ratelLogRecordProcessor({ ...configOpts, logFilter }), ...logRecordProcessors],
  });
  const handle: TelemetryHandle = {
    forceFlush: () => flushProviders(provider, loggerProvider),
    shutdown: async () => {
      try {
        await shutdownProviders(provider, loggerProvider);
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
  Object.defineProperty(loggerProvider, RATEL_LOGGER_PROVIDER_HANDLE, { value: handle });
  provider.register();
  const winner = activeGlobalProvider();
  if (winner !== provider) {
    // Lost a registration race. If Ratel already owns the winner, honor idempotence and
    // return its handle; only a truly foreign winner is a composition error.
    void shutdownProviders(provider, loggerProvider);
    const winnerHandle = ratelOwnedHandle(winner);
    if (winnerHandle) return winnerHandle;
    throw foreignProviderError();
  }
  const loggerWinner = logs.setGlobalLoggerProvider(loggerProvider);
  if (loggerWinner !== loggerProvider) {
    trace.disable();
    void shutdownProviders(provider, loggerProvider);
    throw foreignProviderError();
  }
  return handle;
}

/** Back-compat alias for {@link startTelemetry}. */
export const init = startTelemetry;

async function flushProviders(
  tracerProvider: NodeTracerProvider,
  loggerProvider: LoggerProvider,
): Promise<void> {
  await settleProviderOperations(
    [tracerProvider.forceFlush(), loggerProvider.forceFlush()],
    "OpenTelemetry tracer and logger flush failed",
  );
}

async function shutdownProviders(
  tracerProvider: NodeTracerProvider,
  loggerProvider: LoggerProvider,
): Promise<void> {
  await settleProviderOperations(
    [tracerProvider.shutdown(), loggerProvider.shutdown()],
    "OpenTelemetry tracer and logger shutdown failed",
  );
}

async function settleProviderOperations(
  operations: Promise<void>[],
  aggregateMessage: string,
): Promise<void> {
  const results = await Promise.allSettled(operations);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, aggregateMessage);
  }
}

function providerIsShutDown(provider: unknown): boolean {
  if ((typeof provider !== "object" && typeof provider !== "function") || provider === null) {
    return false;
  }
  return Reflect.get(provider, RATEL_PROVIDER_SHUTDOWN) === true;
}

function isDefaultLoggerProvider(provider: unknown): boolean {
  if ((typeof provider !== "object" && typeof provider !== "function") || provider === null) {
    return false;
  }
  return (
    Reflect.get(provider, "constructor")?.name === "ProxyLoggerProvider" &&
    typeof Reflect.get(provider, "_getDelegate") === "function"
  );
}

function foreignProviderError(): Error {
  return new Error(
    "ratel telemetry init(): an OpenTelemetry TracerProvider or LoggerProvider is already " +
      "registered globally, so init() (the turnkey path that owns the providers) cannot take " +
      "over. To send Ratel " +
      "telemetry alongside existing providers (e.g. Langfuse + the Vercel AI SDK), add " +
      "ratelSpanProcessor({ apiKey }) and ratelLogRecordProcessor({ apiKey }) to the host " +
      "providers instead of calling init().",
  );
}

function alreadyShutDownError(): Error {
  return new Error(
    "ratel telemetry init(): telemetry was already shut down in this process. The global " +
      "OpenTelemetry providers are registered once, so a later init() cannot re-take them. " +
      "Call trace.disable() and logs.disable() before init() if you must re-initialize (e.g. in tests).",
  );
}

function providerPairLostError(): Error {
  return new Error(
    "ratel telemetry init(): the Ratel TracerProvider is active but its paired " +
      "LoggerProvider is no longer registered, so EventRecords cannot be exported. Disable " +
      "both global providers before re-initializing, or keep the original pair active.",
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

function ratelOwnedLoggerHandle(provider: unknown): TelemetryHandle | undefined {
  if ((typeof provider !== "object" && typeof provider !== "function") || provider === null) {
    return undefined;
  }
  const handle: unknown = Reflect.get(provider, RATEL_LOGGER_PROVIDER_HANDLE);
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
