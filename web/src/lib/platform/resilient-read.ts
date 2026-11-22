import { type Attributes, trace } from "@opentelemetry/api";
import { getLogger, type LogError } from "@/lib/platform/logger";
import { reportServerException } from "@/lib/platform/telemetry";

export interface ResilientReadDeps {
  addSpanEvent?: (name: string, attributes: Attributes) => void;
  logError: LogError;
  reportServerException: typeof reportServerException;
}

export interface ResilientReadParams<T> {
  /** snake_case identifier of the read, surfaced in logs and capture props. */
  operation: string;
  /** Distinct id the failure is attributed to, e.g. `project:<id>`. */
  distinctId: string;
  /** Value returned when the read fails, so the page can still render. */
  fallback: T;
  load: () => Promise<T>;
}

const logger = getLogger("observability/resilient-read");
const defaultDeps: ResilientReadDeps = {
  addSpanEvent: (name, attributes) => trace.getActiveSpan()?.addEvent(name, attributes),
  logError: (message, error, fields) => logger.error({ ...fields, err: error }, message),
  reportServerException,
};

/**
 * Run a non-critical read and degrade to `fallback` if it fails, so one slow or
 * failing supplementary query (KPIs, experiment detection) can't take down the
 * whole page. Never silent: the original error is logged and reported before
 * the fallback is returned.
 */
export async function loadOrFallback<T>(
  { operation, distinctId, fallback, load }: ResilientReadParams<T>,
  deps: ResilientReadDeps = defaultDeps,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    deps.logError("read degraded to fallback", error, { operation });
    deps.addSpanEvent?.("read_degraded", { operation });
    deps.reportServerException(error, distinctId, {
      operation,
      degraded: true,
    });
    return fallback;
  }
}
