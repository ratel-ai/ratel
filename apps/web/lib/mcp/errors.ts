/**
 * Machine-readable failure codes for the MCP surface.
 *
 * Two layers fail differently. Transport-level problems (no credential, rate
 * limit, oversized body) are HTTP responses the MCP client never turns into a tool
 * result. Everything after dispatch starts is a *tool result* carrying
 * `isError`, because by then the model is waiting on an answer and an HTTP
 * status would be swallowed by the client.
 *
 * Codes mirror `lib/v1-errors.ts` in spirit (`error` is the machine code and
 * `reason` the finer-grained discriminator) so an agent that already knows the
 * v1 wire contract reads these without a second vocabulary.
 */
export type McpErrorCode =
  /** Missing, malformed, revoked, or expired credential. */
  | "unauthorized"
  /** Per-credential or process-wide token bucket rejected the call. */
  | "rate_limited"
  /** Database not configured: the whole surface is unavailable, not empty. */
  | "unavailable"
  /** `operation_id` is not in the registry. */
  | "unknown_operation"
  /** Params failed the operation's zod schema. */
  | "invalid_params"
  /** The credential is valid but may not act on the requested scope. */
  | "forbidden"
  /** The entity does not exist *within the caller's authorized scope*. */
  | "not_found"
  /** A read exceeded the statement timeout: the window was too wide. */
  | "timeout"
  /** State conflict on a write (mirrors the v1 conflict reasons). */
  | "conflict"
  /** A plan limit rejected a write. */
  | "quota_exceeded"
  /** Unexpected failure; details are logged, never returned. */
  | "internal";

export interface McpErrorBody {
  ok: false;
  error: McpErrorCode;
  message: string;
  /** Finer-grained discriminator, e.g. a v1 mutation reason or a quota key. */
  reason?: string;
  /** Set on `invalid_params`: flattened zod issues. */
  issues?: readonly { path: string; message: string }[];
  /** Set on `rate_limited`. */
  retryAfterSeconds?: number;
}

export class McpOperationError extends Error {
  readonly code: McpErrorCode;
  readonly detail: Omit<McpErrorBody, "ok" | "error" | "message">;

  constructor(
    code: McpErrorCode,
    message: string,
    detail: Omit<McpErrorBody, "ok" | "error" | "message"> = {},
  ) {
    super(message);
    this.name = "McpOperationError";
    this.code = code;
    this.detail = detail;
  }

  toBody(): McpErrorBody {
    return { ok: false, error: this.code, message: this.message, ...this.detail };
  }
}

/**
 * A cross-tenant miss and a genuinely absent row return the *same* body.
 * Distinguishing them would turn the surface into an id-enumeration oracle: a
 * caller could probe UUIDs and learn which ones exist in other organizations.
 */
export function notFound(entity: string): McpOperationError {
  return new McpOperationError("not_found", `No ${entity} found.`);
}

export function invalidParams(
  message: string,
  issues?: readonly { path: string; message: string }[],
): McpOperationError {
  return new McpOperationError("invalid_params", message, issues ? { issues } : {});
}

export function unknownOperation(operationId: string): McpOperationError {
  return new McpOperationError(
    "unknown_operation",
    `No operation named "${operationId}". Call tools/list to see the available tools.`,
  );
}

export function forbidden(message: string): McpOperationError {
  return new McpOperationError("forbidden", message);
}

/**
 * Postgres cancels a statement that outruns `lib/db/statement-timeout.ts`.
 * Agents ask for far wider ranges than the console ever does, so this is a
 * routine outcome and gets an actionable message rather than a 500.
 */
const STATEMENT_TIMEOUT_CODES = new Set(["57014", "57P01"]);

export function isStatementTimeout(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && STATEMENT_TIMEOUT_CODES.has(code);
}

export function timeout(): McpOperationError {
  return new McpOperationError(
    "timeout",
    "The query took too long. Narrow the time window or lower the limit and retry.",
  );
}
