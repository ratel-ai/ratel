/**
 * Typed error taxonomy for the loader, mapped from the frozen v1 error body
 * `{ error: { code, message, details? } }` (`protocol/v1/schema/error.schema.json`).
 * A malformed body falls back to the HTTP status alone.
 */

/** No source is configured / the configuration is unusable. Fails fast, never retried. */
export class CloudConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudConfigError";
  }
}

/** 401 — missing, malformed, unknown, or revoked key. Terminal for a sync chain. */
export class CloudAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudAuthError";
  }
}

/** Any other non-2xx the source answered with (400, 404, unexpected statuses). */
export class CloudApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "CloudApiError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

/** 503 or a network-level failure — the source is unreachable; the replica stays live. */
export class CloudUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CloudUnavailableError";
  }
}

/** Parse the frozen error body, tolerating malformed bodies (HTTP status wins). */
export function errorFromResponse(status: number, bodyText: string): Error {
  let code: string | undefined;
  let message = `catalog source responded ${status}`;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error;
    if (typeof error?.code === "string") code = error.code;
    if (typeof error?.message === "string") message = `${message}: ${error.message}`;
  } catch {
    // Malformed error body — fall back to the HTTP status.
  }
  if (status === 401) return new CloudAuthError(message);
  if (status === 503) return new CloudUnavailableError(message);
  return new CloudApiError(message, status, code);
}
