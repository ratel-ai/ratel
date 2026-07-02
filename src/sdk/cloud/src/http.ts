import { CloudAuthError, CloudUnavailableError } from "./errors.js";

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Minimal authenticated HTTP layer over global `fetch`. Maps the two
 * cross-cutting failure classes (unreachable, rejected key) to typed errors;
 * endpoint-specific statuses (304, 202, 404, 409) stay with their callers.
 */
export class CloudHttp {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async request(path: string, init: HttpRequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (err) {
      throw new CloudUnavailableError(`Ratel Cloud unreachable at ${this.baseUrl}${path}`, {
        cause: err,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new CloudAuthError(
        `Ratel Cloud rejected the project API key (HTTP ${response.status})`,
      );
    }
    return response;
  }
}
