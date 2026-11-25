import type { Config } from "@/config";
import type { RequestErrorContext, RequestErrorRequest } from "@/lib/contracts/telemetry";
import type { StaticTelemetryEnvironment } from "@/lib/platform/otel/config";
import type { TelemetryShutdown } from "@/lib/platform/otel/shutdown";

const EXPORT_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 6_000;
const LOG_SCHEDULE_DELAY_MS = 1_000;

let registered = false;
let registeredShutdown: TelemetryShutdown | undefined;

/**
 * The platform's own traces and logs (owned port of upstream's registration, without its
 * analytics vendor), and its server traces for APM. Nothing is registered, and the OpenTelemetry
 * SDK is not even loaded, unless both self-telemetry OTLP endpoints are set
 * (`lib/platform/otel/config.ts`) or the APM collector's `otel.serverTraces.endpoint` is
 * (`lib/platform/otel/server-traces.ts`): an unconfigured process exports nothing. Returns the
 * flush to run before the process exits.
 *
 * Call it before anything loads `pg`: the instrumentations patch modules as they load.
 */
export async function registerNodeInstrumentation(
  settings: Config,
  staticEnvironment: StaticTelemetryEnvironment,
): Promise<TelemetryShutdown | undefined> {
  if (registered) return registeredShutdown;

  const {
    isTelemetryExportOrigin,
    processResourceAttributes,
    resolveSelfTelemetryConfig,
    selfTelemetryConfigWarnings,
  } = await import("@/lib/platform/otel/config");
  const { resolveServerTracesConfig } = await import("@/lib/platform/otel/server-traces");
  const config = resolveSelfTelemetryConfig(settings, staticEnvironment);
  for (const warning of selfTelemetryConfigWarnings(settings, staticEnvironment, config)) {
    console.warn(warning);
  }
  const serverTraces = resolveServerTracesConfig(settings);
  if (!config && !serverTraces) return undefined;

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
    { FilteredSpanProcessor, isModelCallSpan, resolveRatelExportConfig, sameOrigin },
    { isMcpToolSpan, mcpExportProcessors, resolveMcpExportConfig },
    { editionAnalyticsShutdown },
    { serverTracesProcessor },
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
    import("@/lib/platform/otel/ratel-export"),
    import("@/lib/mcp/telemetry/export"),
    import("@/lib/platform/edition-telemetry"),
    import("@/lib/platform/otel/server-traces"),
  ]);

  const resource = resourceFromAttributes(
    config?.resourceAttributes ?? processResourceAttributes(settings, staticEnvironment),
  );
  // Ratel's own model calls go to a Ratel project (lib/platform/otel/ratel-export.ts),
  // and only there: the self-telemetry exporter keeps every other span, as before. Both ride
  // on self-telemetry, so neither is on without it.
  const ratelExport = config ? resolveRatelExportConfig(settings) : null;
  // Ratel's own MCP tool calls go to their own project (lib/mcp/telemetry/export.ts).
  const mcpExport = config ? resolveMcpExportConfig(settings) : null;
  const tracerProvider = new NodeTracerProvider({
    resource,
    sampler: createSelfTelemetrySampler(
      config?.tracesSamplerRatio ?? settings.otel.tracesSamplerRatio,
    ),
    spanProcessors: [
      new SelfTimeSpanProcessor(),
      ...(config
        ? [
            new FilteredSpanProcessor(
              new BatchSpanProcessor(new OTLPTraceExporter(config.traces), {
                exportTimeoutMillis: EXPORT_TIMEOUT_MS,
              }),
              (span) => !isModelCallSpan(span) && !isMcpToolSpan(span),
            ),
          ]
        : []),
      // Server traces for APM (Cloud: the Datadog Agent sidecar), with their own resource.
      ...(serverTraces
        ? [
            serverTracesProcessor(serverTraces, {
              accept: (span) => !isModelCallSpan(span) && !isMcpToolSpan(span),
              baseResource: resource,
              exportTimeoutMillis: EXPORT_TIMEOUT_MS,
            }),
          ]
        : []),
      ...(ratelExport
        ? [
            new FilteredSpanProcessor(
              new BatchSpanProcessor(new OTLPTraceExporter(ratelExport), {
                exportTimeoutMillis: EXPORT_TIMEOUT_MS,
              }),
              isModelCallSpan,
            ),
          ]
        : []),
      ...mcpExportProcessors(mcpExport),
    ],
  });
  // Logs are self-telemetry's only: server traces send none.
  const loggerProvider = config
    ? new LoggerProvider({
        resource,
        processors: [
          new BatchLogRecordProcessor({
            exporter: new OTLPLogExporter(config.logs),
            exportTimeoutMillis: EXPORT_TIMEOUT_MS,
            scheduledDelayMillis: LOG_SCHEDULE_DELAY_MS,
          }),
        ],
      })
    : undefined;

  tracerProvider.register({ contextManager: new AsyncLocalStorageContextManager() });
  if (loggerProvider) logs.setGlobalLoggerProvider(loggerProvider);
  registerInstrumentations({
    tracerProvider,
    loggerProvider,
    instrumentations: [
      new UndiciInstrumentation({
        ignoreRequestHook: ({ origin }) =>
          (config !== null && isTelemetryExportOrigin(origin, config)) ||
          (serverTraces !== null && sameOrigin(origin, serverTraces.url)) ||
          (ratelExport !== null && sameOrigin(origin, ratelExport.url)) ||
          (mcpExport !== null && sameOrigin(origin, mcpExport.url)),
      }),
      new PgInstrumentation({ requireParentSpan: true }),
      ...(loggerProvider ? [new PinoInstrumentation()] : []),
    ],
  });

  registeredShutdown = createTelemetryShutdown({
    tracerProvider,
    loggerProvider: loggerProvider ?? { forceFlush: async () => {} },
    // The edition's analytics flush, its port loaded only now: the composition loads after
    // this registration, so its modules see the patched `pg` and `fetch`.
    shutdownAnalytics: editionAnalyticsShutdown(EXPORT_TIMEOUT_MS),
    reportError: (error) => {
      console.warn("[otel] telemetry shutdown failed", error);
    },
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });
  // With NEXT_MANUAL_SIG_HANDLE=true Next installs no signal handler and this one owns
  // termination: it flushes buffered telemetry, then exits explicitly. The worker is the
  // exception: its own handler waits for the step in flight, so it runs this flush itself
  // (`bootBackground` hands it over) instead of being cut short by an exit from here.
  if (appRole(settings) !== "worker") registerTelemetryShutdownHandlers(registeredShutdown);
  registered = true;
  return registeredShutdown;
}

/**
 * Upstream's `onRequestError` body, without its vendor: the edition's port reports the error,
 * the open-source edition has none and reports nothing.
 */
export async function reportRequestError(
  error: unknown,
  request: RequestErrorRequest,
  context: RequestErrorContext,
): Promise<void> {
  const { forwardRequestError } = await import("@/lib/platform/edition-telemetry");
  await forwardRequestError(error, request, context);
}

/**
 * This process's settings (`web/src/config.ts`), read first at boot. An invalid value exits with
 * the ConfigError that names it, like a bad composition: never serve a misconfigured server.
 */
export async function bootConfig(): Promise<Config> {
  try {
    const { getConfig } = await import("@/config");
    return getConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * Memory and event loop once a minute from every process (upstream's RC-216), where this
 * process exports its own telemetry: the deployments whose logs reach a dashboard. Upstream keys
 * it on its production and staging environments, which are the ones that export.
 */
export async function startProcessStatsIfExported(config?: Config): Promise<void> {
  const { selfTelemetryEnabled } = await import("@/lib/platform/otel/config");
  if (!selfTelemetryEnabled(config)) return;
  const { startProcessStats } = await import("@/lib/platform/process-stats");
  startProcessStats(config);
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
    const { setEditionServiceName } = await import("@/lib/platform/app-config");
    setEditionServiceName(composition.productName?.short);
    if (composition.connect) {
      const { createToolCorpus } = await import("@/lib/synthesis/tool-corpus");
      const { createImportedRuns } = await import("@/lib/ledger/imported-runs");
      const { createOnboardingService } = await import("@/lib/console/onboarding/core-service");
      const { getConfig } = await import("@/config");
      composition.connect({
        toolCorpus: createToolCorpus(),
        importedRuns: createImportedRuns(),
        onboarding: createOnboardingService(),
        // The value the configuration forces for a core flag, for the edition's own flag reads.
        forcedFlag: (flag) => getConfig().flags[flag],
      });
    }
    // An edition's MCP tools are checked now, so a bad one stops startup, not a client's call.
    if (composition.registry.registrations().some((r) => r.mcpOperations?.length)) {
      const { assembleOperations } = await import("@/lib/mcp/operations");
      assembleOperations();
    }
    const { configuredOrganizationName } = await import("@/lib/platform/deployment-config");
    configuredOrganizationName();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

/**
 * What the open-source edition does for itself at boot, by this process's role (`app.role`,
 * APP_ROLE, `lib/jobs/boot-plan.ts`): apply migrations (on by default for OSS,
 * `database.migrateOnBoot` false opts out; the worker never migrates, the web process does),
 * then run the cron tick in process (`jobs.cron` inprocess, the OSS default) or, as the
 * worker, the job loop. An API-only process starts neither: it only queues. A migration
 * failure or an external scheduler with no `jobs.cronSecret` exits, like a bad composition:
 * never serve a misconfigured server. Nothing here runs without a `database.url`. In the
 * open-source edition it also starts the model status: the setup in the log, each failed model
 * call in one sentence.
 *
 * `flushTelemetry` is what `registerNodeInstrumentation` returned: the worker runs it after its
 * last step, before it exits.
 */
export async function bootBackground(flushTelemetry?: TelemetryShutdown): Promise<void> {
  const { getConfig } = await import("@/config");
  const url = getConfig().database.url;
  if (!url) return;
  const { exposureWarnings } = await import("@/lib/platform/deployment-config");
  for (const warning of exposureWarnings()) console.warn(`[deployment] ${warning}`);
  const { bootPlan } = await import("@/lib/jobs/boot-plan");
  const plan = bootPlan();
  if (plan.migrate) {
    const { runMigrations } = await import("@/lib/platform/db/migrate");
    try {
      await runMigrations({ url });
    } catch (error) {
      console.error("[migrate] failed; refusing to serve against a mismatched schema");
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  } else if (plan.role === "worker") {
    console.log("[migrate] skipped: the worker never migrates, the web process does");
  }
  // The models' setup in the log, and each failed call in one sentence kept for the console's
  // Models settings (ADR-0009 §13). The open-source edition's own: another edition reports its own.
  const { composition, OSS_EDITION } = await import("@/lib/composition");
  if (composition.edition === OSS_EDITION) {
    const { startModelStatus } = await import("@/lib/readings/models/status");
    startModelStatus();
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
