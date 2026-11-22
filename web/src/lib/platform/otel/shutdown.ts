type FlushableProvider = {
  forceFlush(): Promise<void>;
};

type TerminationSignal = "SIGTERM" | "SIGINT";

type ShutdownProcess = {
  once(signal: TerminationSignal, handler: () => void): unknown;
  exit(code: number): void;
};

// Conventional 128 + signal-number exit codes, matching what Next's own
// standalone handler reports so ECS still reads the stop as expected.
const SIGNAL_EXIT_CODES: Record<TerminationSignal, number> = {
  SIGTERM: 143,
  SIGINT: 130,
};

export type TelemetryShutdown = () => Promise<void>;

export type TelemetryShutdownDependencies = {
  tracerProvider: FlushableProvider;
  loggerProvider: FlushableProvider;
  shutdownAnalytics(): Promise<void> | void;
  reportError: (error: unknown) => void;
  timeoutMs: number;
};

export function createTelemetryShutdown({
  tracerProvider,
  loggerProvider,
  shutdownAnalytics,
  reportError,
  timeoutMs,
}: TelemetryShutdownDependencies): TelemetryShutdown {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    const operations = [
      () => tracerProvider.forceFlush(),
      () => loggerProvider.forceFlush(),
      shutdownAnalytics,
    ];
    shutdownPromise ??= settleWithin(
      Promise.allSettled(operations.map((operation) => Promise.resolve().then(operation))).then(
        (results) => {
          for (const result of results) {
            if (result.status === "rejected") reportError(result.reason);
          }
        },
      ),
      timeoutMs,
    );
    return shutdownPromise;
  };
}

export function registerTelemetryShutdownHandlers(
  shutdown: TelemetryShutdown,
  shutdownProcess: ShutdownProcess = process,
): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    shutdownProcess.once(signal, () => {
      // Next's own SIGTERM/SIGINT handler is disabled via NEXT_MANUAL_SIG_HANDLE=1,
      // so this handler owns termination: flush buffered telemetry (bounded by the
      // shutdown timeout budget), then exit explicitly. Registering a listener
      // suppresses Node's default terminate-on-signal, so without this exit the
      // process would hang until ECS SIGKILLs it and the flush would be lost anyway.
      void shutdown().finally(() => {
        shutdownProcess.exit(SIGNAL_EXIT_CODES[signal]);
      });
    });
  }
}

function settleWithin(operation: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    operation.finally(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
