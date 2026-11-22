import pino, { type Logger } from "pino";
import type { TelemetryPort } from "@/lib/contracts/telemetry";

/**
 * Events and exceptions as log lines. Names, ids and numbers only: this adapter is also the
 * guarantee that nothing a module tracks reaches a third party in the open-source edition.
 * A logger can be injected so tests read the lines instead of stdout.
 */
export function createOssTelemetry(logger: Logger = defaultLogger()): TelemetryPort {
  return {
    async trackEvent(name, context, properties = {}) {
      try {
        logger.info({ event: name, ...safeFields(context), ...safeFields(properties) }, "event");
      } catch {
        // Never into the caller.
      }
    },
    reportException(error, distinctId, properties = {}) {
      try {
        logger.error(
          { err: error, ...safeFields({ distinct_id: distinctId, ...properties }) },
          "exception",
        );
      } catch {
        // Never into the caller.
      }
    },
  };
}

/**
 * Keep numbers, booleans and short id-like strings; drop objects and any string that could
 * carry content. Applied to every input, context and exception properties included, because
 * this filter is the guarantee the file header makes.
 */
function safeFields(properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string" && /^[\w:.-]{1,64}$/.test(value)) out[key] = value;
  }
  return out;
}

function defaultLogger(): Logger {
  return pino({ name: "telemetry", level: process.env.LOG_LEVEL ?? "info" });
}

export const ossTelemetry: TelemetryPort = createOssTelemetry();
