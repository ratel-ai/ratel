import type {
  RequestErrorContext,
  RequestErrorRequest,
  TelemetryPort,
} from "@/lib/contracts/telemetry";

/**
 * The two telemetry calls the instrumentation makes on the edition's port: an uncaught request
 * error and the analytics flush at shutdown. The port is loaded when the call happens, never at
 * import: instrumentation registers before the composition may load (its modules must load
 * after the OpenTelemetry patches; so must the logger, which the Pino instrumentation patches).
 * The open-source port has neither member, so both do nothing.
 */

type LoadTelemetry = () => Promise<TelemetryPort>;
type Warn = (error: unknown) => void | Promise<void>;

const loadTelemetry: LoadTelemetry = async () => {
  const { composition } = await import("@/lib/composition/ports");
  return composition.telemetry;
};

/** Hand an uncaught request error to the edition. Never throws: it runs inside error handling. */
export async function forwardRequestError(
  error: unknown,
  request: RequestErrorRequest,
  context: RequestErrorContext,
  load: LoadTelemetry = loadTelemetry,
  warn: Warn = warnRequestErrorReport,
): Promise<void> {
  try {
    const telemetry = await load();
    await telemetry.reportRequestError?.(error, request, context);
  } catch (reportError) {
    await warn(reportError);
  }
}

/** The analytics step of the telemetry shutdown: the edition's `shutdown`, loaded when it runs. */
export function editionAnalyticsShutdown(
  timeoutMs: number,
  load: LoadTelemetry = loadTelemetry,
): () => Promise<void> {
  return async () => {
    const telemetry = await load();
    await telemetry.shutdown?.(timeoutMs);
  };
}

async function warnRequestErrorReport(error: unknown): Promise<void> {
  try {
    const { getLogger } = await import("@/lib/platform/logger");
    getLogger("telemetry").warn({ err: error }, "request error report failed");
  } catch {
    // Never into the error handler.
  }
}
