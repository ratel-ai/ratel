import { AsyncLocalStorage } from "node:async_hooks";
import pino, { type DestinationStream, type Logger, stdSerializers } from "pino";

type Environment = Readonly<Record<string, string | undefined>>;

export type LogFields = Readonly<Record<string, unknown>>;
export type LogError = (message: string, err?: unknown, fields?: LogFields) => void;
export type LogWarn = (message: string, fields?: LogFields) => void;

export type LogContext = {
  requestId?: string;
  project_id?: string;
  org_id?: string;
  distinctId?: string;
};

export type CreateLoggerOptions = {
  environment?: Environment;
  destination?: DestinationStream;
};

const REDACTED_FIELDS = [
  "authorization",
  "apiKey",
  "cookie",
  "*.authorization",
  "*.apiKey",
  "*.cookie",
];
const SAFE_ERROR_FIELDS = [
  "type",
  "message",
  "stack",
  "aggregateErrors",
  "code",
  "status",
  "statusCode",
  "requestId",
  "requestID",
  "doc_url",
  "param",
  "decline_code",
  "severity",
  "constraint",
  "table",
  "column",
  "dataType",
  "schema",
  "routine",
  "clerkTraceId",
] as const;
const SAFE_ERROR_FIELD_NAMES = new Set<string>(SAFE_ERROR_FIELDS);
const DERIVED_ERROR_FIELD_NAMES = new Set(["type", "message", "stack", "aggregateErrors"]);
const REDACTED_ERROR_MESSAGE = "[redacted]";
const logContexts = new AsyncLocalStorage<LogContext>();
const rootLogger = createLogger();

export function getLogger(module: string): Logger {
  return rootLogger.child({ module });
}

export function runWithLogContext<T>(context: LogContext, callback: () => T): T {
  return logContexts.run(context, callback);
}

export function setLogContext(context: LogContext): void {
  const activeContext = logContexts.getStore();
  if (!activeContext) return;
  Object.assign(activeContext, context);
}

export function createLogger({
  environment = process.env,
  destination,
}: CreateLoggerOptions = {}): Logger {
  return pino(
    {
      level: environment.LOG_LEVEL || (environment.NODE_ENV === "development" ? "debug" : "info"),
      redact: REDACTED_FIELDS,
      mixin: requestContextMixin,
      serializers: { err: serializeError },
    },
    destination,
  );
}

function serializeError(error: unknown): unknown {
  const serialized = stdSerializers.err(error as Error);

  return filterSerializedError(serialized, error);
}

function filterSerializedError(serialized: unknown, original?: unknown): unknown {
  if (serialized === null || typeof serialized !== "object") return serialized;

  const record = serialized as Record<string, unknown>;
  const aggregateErrors = record.aggregateErrors;
  const originalAggregateErrors = aggregateErrorsFrom(original);
  // SDK serializers can fold response bodies and causes into message/stack.
  // Preserve those derived fields only when every attached diagnostic is safe.
  const redactDetails = hasUntrustedFields(record) || hasUntrustedCause(original);

  return Object.fromEntries(
    SAFE_ERROR_FIELDS.map((field) => [
      field,
      field === "aggregateErrors" && Array.isArray(aggregateErrors)
        ? aggregateErrors.map((error, index) =>
            filterSerializedError(error, originalAggregateErrors?.[index]),
          )
        : field === "message" && redactDetails
          ? REDACTED_ERROR_MESSAGE
          : field === "stack" && redactDetails
            ? redactedErrorStack(record)
            : safeDiagnosticValue(record[field]),
    ]),
  );
}

function hasUntrustedFields(record: Record<string, unknown>): boolean {
  return Object.entries(record).some(
    ([field, value]) =>
      value !== undefined &&
      value !== null &&
      (!SAFE_ERROR_FIELD_NAMES.has(field) ||
        (!DERIVED_ERROR_FIELD_NAMES.has(field) && !isSafeDiagnosticValue(value))),
  );
}

function hasUntrustedCause(error: unknown): boolean {
  return hasUntrustedOriginalError(causeFrom(error), new Set());
}

function hasUntrustedOriginalError(error: unknown, seen: Set<object>): boolean {
  if (error === null || typeof error !== "object" || seen.has(error)) {
    return false;
  }
  seen.add(error);

  const record = error as Record<string, unknown>;
  const hasUnsafeOwnField = Object.entries(record).some(
    ([field, value]) =>
      field !== "cause" &&
      field !== "errors" &&
      value !== undefined &&
      value !== null &&
      (!SAFE_ERROR_FIELD_NAMES.has(field) ||
        (!DERIVED_ERROR_FIELD_NAMES.has(field) && !isSafeDiagnosticValue(value))),
  );
  return hasUnsafeOwnField || hasUntrustedOriginalError(causeFrom(error), seen);
}

function causeFrom(error: unknown): unknown {
  if (error === null || typeof error !== "object") return undefined;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== "function") return cause;
  try {
    return cause.call(error);
  } catch {
    return undefined;
  }
}

function aggregateErrorsFrom(error: unknown): unknown[] | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const errors = (error as { errors?: unknown }).errors;
  return Array.isArray(errors) ? errors : undefined;
}

function redactedErrorStack(record: Record<string, unknown>): string {
  const type = typeof record.type === "string" ? record.type : "Error";
  const stackFrames =
    typeof record.stack === "string"
      ? record.stack.split("\n").filter((line) => /^\s+at\s/.test(line))
      : [];
  return [`${type}: ${REDACTED_ERROR_MESSAGE}`, ...stackFrames].join("\n");
}

function safeDiagnosticValue(value: unknown): unknown {
  return isSafeDiagnosticValue(value) ? value : undefined;
}

function isSafeDiagnosticValue(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function requestContextMixin(): LogContext {
  const context = logContexts.getStore();
  if (!context) return {};

  return {
    ...context,
    distinctId:
      context.distinctId ?? (context.project_id ? `project:${context.project_id}` : undefined),
  };
}
