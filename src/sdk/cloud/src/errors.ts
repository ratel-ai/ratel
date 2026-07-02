/** Missing/invalid client configuration (no API key, no base URL). */
export class CloudConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudConfigError";
  }
}

/** The project API key was rejected (401/403) — retrying won't help. */
export class CloudAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudAuthError";
  }
}

/** Cloud answered with an application error (4xx/5xx with a payload). */
export class CloudApiError extends Error {
  readonly status: number;
  /** Machine code from the response body when present (e.g. "not_found", "conflict"). */
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "CloudApiError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

/** Cloud was unreachable (network failure, DNS, refused connection). */
export class CloudUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CloudUnavailableError";
  }
}
