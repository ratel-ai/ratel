import { APIConnectionError, APIConnectionTimeoutError } from "@anthropic-ai/sdk";

/**
 * The `error_type` a `model_call` line and its span carry: a stable string an
 * on-call person can group by. Never a class name, because the production
 * bundle mangles class names (RC-713: Bedrock 503s logged `error_type: h`).
 *
 * In order:
 * 1. The error's own `errorType` (`model_not_enabled`, `quota_exhausted`).
 * 2. A decision engine's failure `reason`, in the shared words below.
 * 3. The HTTP `status` of an SDK error.
 * 4. The SDK's own error `type`, when there is no status.
 * 5. A connection that failed, timed out or was aborted.
 * 6. Else `unknown`.
 *
 * A leaf module: it reads fields, so it imports no call site's error classes.
 */

export type ErrorType = string;

/** Decision engine `reason`s (`DecisionCallError`, `PickCallError`) in the shared words. */
const REASONS: Readonly<Record<string, ErrorType>> = {
  credentials: "unauthorized",
  rate_limited: "throttled",
  unavailable: "unavailable",
  unreadable: "bad_response",
  deadline: "timeout",
  refused: "refused",
};

/** HTTP statuses with a word of their own; other 4xx are `client_error`, 5xx `server_error`. */
const STATUSES: Readonly<Record<number, ErrorType>> = {
  400: "bad_request",
  401: "unauthorized",
  402: "quota_exhausted",
  403: "access_denied",
  404: "not_found",
  408: "timeout",
  422: "bad_request",
  429: "throttled",
};

/** A word made of lowercase letters and underscores: safe to log as a type. */
const WORD = /^[a-z][a-z0-9_]*$/;

/** The stable type of a failed call's error; undefined when there is no error. */
export function stableErrorType(error: unknown): ErrorType | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error !== "object") return "unknown";
  const fields = error as {
    errorType?: unknown;
    reason?: unknown;
    status?: unknown;
    type?: unknown;
    name?: unknown;
    message?: unknown;
  };
  if (typeof fields.errorType === "string" && WORD.test(fields.errorType)) return fields.errorType;
  if (typeof fields.reason === "string" && REASONS[fields.reason]) return REASONS[fields.reason];
  if (typeof fields.status === "number") return statusType(fields.status);
  if (typeof fields.type === "string" && WORD.test(fields.type)) return fields.type;
  return connectionType(error, fields.name, fields.message) ?? "unknown";
}

function statusType(status: number): ErrorType {
  if (STATUSES[status]) return STATUSES[status];
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "unknown";
}

/**
 * A connection that never got an answer. SDK classes are matched by identity,
 * which survives minification; `name` is set by the runtime for DOMExceptions.
 */
function connectionType(error: object, name: unknown, message: unknown): ErrorType | null {
  if (error instanceof APIConnectionTimeoutError || name === "TimeoutError") return "timeout";
  if (name === "AbortError") return "aborted";
  if (error instanceof APIConnectionError) return "connection_error";
  if (error instanceof TypeError && message === "fetch failed") return "connection_error";
  return null;
}
