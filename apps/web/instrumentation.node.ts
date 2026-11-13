import type { StaticTelemetryEnvironment } from "@/lib/platform/otel/config";
import type { TelemetryShutdown } from "@/lib/platform/otel/shutdown";

type Environment = Readonly<Record<string, string | undefined>>;

const EXPORT_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 6_000;
const LOG_SCHEDULE_DELAY_MS = 1_000;

let registered = false;
let registeredShutdown: TelemetryShutdown | undefined;

/**
 * The platform's own traces and logs (owned port of upstream's registration, without its
 * analytics vendor). Nothing is registered, and the OpenTelemetry SDK is not even loaded, unless
 * both OTLP endpoints are set (`lib/platform/otel/config.ts`): an unconfigured process exports
 * nothing. Returns the flush to run before the process exits.
 *
 * Call it before anything loads `pg`: the instrumentations patch modules as they load.
 */
export async function registerNodeInstrumentation(
  environment: Environment,
  staticEnvironment: StaticTelemetryEnvironment,
): Promise<TelemetryShutdown | undefined> {
  if (registered) return registeredShutdown;

  const { isTelemetryExportOrigin, resolveSelfTelemetryConfig, selfTelemetryConfigWarnings } =
    await import("@/lib/platform/otel/config");
  const config = resolveSelfTelemetryConfig(environment, staticEnvironment);
  for (const warning of selfTelemetryConfigWarnings(environment, staticEnvironment, config)) {
    console.warn(warning);
  }
  if (!config) return undefined;

  const [
    { logs },
    { AsyncLocalStorageContextManager },
    { OTLPLogExporter },
    { OTLPTraceExporter },
    { registerInstrumentations },
    { PgInstrumentation },
    { PinoInstrumentation },
    { UndiciInstrumentation },
    { resourceFromAttributes },
    { BatchLogRecordProcessor, LoggerProvider },
    { BatchSpanProcessor },
    { NodeTracerProvider },
    { createSelfTelemetrySampler },
    { SelfTimeSpanProcessor },
    { createTelemetryShutdown, registerTelemetryShutdownHandlers },
    { appRole },
  ] = await Promise.all([
    import("@opentelemetry/api-logs"),
    import("@opentelemetry/context-async-hooks"),
    import("@opentelemetry/exporter-logs-otlp-http"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/instrumentation"),
    import("@opentelemetry/instrumentation-pg"),
    import("@opentelemetry/instrumentation-pino"),
    import("@opentelemetry/instrumentation-undici"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-logs"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/sdk-trace-node"),
    import("@/lib/platform/otel/sampler"),
    import("@/lib/platform/otel/self-time-processor"),
    import("@/lib/platform/otel/shutdown"),
    import("@/lib/jobs/role"),
  ]);

  const resource = resourceFromAttributes(config.resourceAttributes);
  const tracerProvider = new NodeTracerProvider({
    resource,
    sampler: createSelfTelemetrySampler(config.tracesSamplerRatio),
    spanProcessors: [
      new SelfTimeSpanProcessor(),
      new BatchSpanProcessor(new OTLPTraceExporter(config.traces), {
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter(config.logs),
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
        scheduledDelayMillis: LOG_SCHEDULE_DELAY_MS,
      }),
    ],
  });

  tracerProvider.register({ contextManager: new AsyncLocalStorageContextManager() });
  logs.setGlobalLoggerProvider(loggerProvider);
  registerInstrumentations({
    tracerProvider,
    loggerProvider,
    instrumentations: [
      new UndiciInstrumentation({
        ignoreRequestHook: ({ origin }) => isTelemetryExportOrigin(origin, config),
      }),
      new PgInstrumentation({ requireParentSpan: true }),
      new PinoInstrumentation(),
    ],
  });

  registeredShutdown = createTelemetryShutdown({
    tracerProvider,
    loggerProvider,
    shutdownAnalytics: () => {},
    reportError: (error) => {
      console.warn("[otel] telemetry shutdown failed", error);
    },
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });
  // With NEXT_MANUAL_SIG_HANDLE=true Next installs no signal handler and this one owns
  // termination: it flushes buffered telemetry, then exits explicitly. The worker is the
  // exception: its own handler waits for the step in flight, so it runs this flush itself
  // (`bootBackground` hands it over) instead of being cut short by an exit from here.
  if (appRole(environment) !== "worker") registerTelemetryShutdownHandlers(registeredShutdown);
  registered = true;
  return registeredShutdown;
}

/**
 * Node-only boot. Kept out of instrumentation.ts so the Edge bundle never sees process.exit
 * (Next analyzes that file for both runtimes).
 *
 * Next logs an instrumentation failure and keeps serving, so exit here is deliberate: a wrong
 * RATEL_COMPOSITION must never become a healthy container.
 */
export async function assertComposition(): Promise<void> {
  try {
    const { composition } = await import("@/lib/composition");
    composition.session.assertConfigured?.();
    if (composition.connect) {
      const { createToolCorpus } = await import("@/lib/synthesis/tool-corpus");
      const { createImportedRuns } = await import("@/lib/ledger/imported-runs");
      composition.connect({ toolCorpus: createToolCorpus(), importedRuns: createImportedRuns() });
    }
    const { configuredOrganizationName } = await import("@/lib/platform/deployment-config");
    configuredOrganizationName();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * What the open-source edition does for itself at boot, by this process's role (`APP_ROLE`,
 * `lib/jobs/boot-plan.ts`): apply migrations (on by default for OSS,
 * `DATABASE_MIGRATE_ON_BOOT=0` opts out; the worker never migrates, the web process does),
 * then run the cron tick in process (`RATEL_CRON=inprocess`, the OSS default) or, as the
 * worker, the job loop. An API-only process starts neither: it only queues. A migration
 * failure or an external scheduler with no `CRON_SECRET` exits, like a bad composition: never
 * serve a misconfigured server. Nothing here runs without a DATABASE_URL.
 *
 * `flushTelemetry` is what `registerNodeInstrumentation` returned: the worker runs it after its
 * last step, before it exits.
 */
export async function bootBackground(flushTelemetry?: TelemetryShutdown): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const { exposureWarnings } = await import("@/lib/platform/deployment-config");
  for (const warning of exposureWarnings()) console.warn(`[deployment] ${warning}`);
  const { bootPlan } = await import("@/lib/jobs/boot-plan");
  const plan = bootPlan();
  if (plan.migrate) {
    const { runMigrations } = await import("@/lib/platform/db/migrate");
    try {
      await runMigrations({ url: process.env.DATABASE_URL });
    } catch (error) {
      console.error("[migrate] failed; refusing to serve against a mismatched schema");
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else if (plan.role === "worker") {
    console.log("[migrate] skipped: the worker never migrates, the web process does");
  }
  const { assertCronConfig, startInProcessScheduler } = await import("@/lib/jobs/scheduler");
  try {
    assertCronConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  if (plan.tick === "scheduler") {
    const { runDrainTick } = await import("@/lib/jobs/drain");
    startInProcessScheduler({
      tick: () => runDrainTick(),
      onError: (error) =>
        console.error("[cron] tick failed", error instanceof Error ? error.message : error),
    });
  }
  if (plan.tick === "worker") {
    const { startBackgroundWorker } = await import("@/lib/jobs/worker-start");
    startBackgroundWorker(undefined, { beforeExit: flushTelemetry });
  }
}
