// The HTTP adapter of `ratel sandbox dev`: trades the project key for a short-lived
// gateway token, so the long-lived key never travels on the socket URL.

export const CONNECT_PATH = "/api/v1/runner/connect";

export interface GatewayGrant {
  readonly gatewayUrl: string;
  readonly token: string;
  readonly expiresAt?: string;
  /** Lets the runner print playground links. Optional: older controllers omit it. */
  readonly projectId?: string;
}

/** A failed exchange. `fatal` means retrying cannot help (bad key, sandboxes off). */
export class ConnectError extends Error {
  override readonly name = "ConnectError";
  constructor(
    message: string,
    readonly fatal: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ExchangeTokenOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

/** POST /api/v1/runner/connect with the project key. Resolves with the gateway URL and token. */
export async function exchangeToken(options: ExchangeTokenOptions): Promise<GatewayGrant> {
  const doFetch = options.fetch ?? fetch;
  const url = new URL(CONNECT_PATH, options.baseUrl);
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: "{}",
      signal: options.signal,
    });
  } catch (err) {
    throw new ConnectError(`cannot reach ${url.origin}: ${messageOf(err)}`, false);
  }
  if (!response.ok) throw failure(response.status, url);
  const body = (await response.json().catch(() => undefined)) as Partial<GatewayGrant> | undefined;
  if (typeof body?.gatewayUrl !== "string" || typeof body.token !== "string") {
    throw new ConnectError(`${url.origin} answered without a gateway URL and token`, false);
  }
  return {
    gatewayUrl: body.gatewayUrl,
    token: body.token,
    ...(typeof body.expiresAt === "string" ? { expiresAt: body.expiresAt } : {}),
    ...(typeof body.projectId === "string" ? { projectId: body.projectId } : {}),
  };
}

/** `wss://<gateway>/runner?token=…`, keeping any path prefix of the gateway URL. */
export function runnerSocketUrl(gatewayUrl: string, token: string): string {
  const base = gatewayUrl.endsWith("/") ? gatewayUrl : `${gatewayUrl}/`;
  const url = new URL("runner", base);
  url.searchParams.set("token", token);
  return url.href;
}

function failure(status: number, url: URL): ConnectError {
  if (status === 401 || status === 403)
    return new ConnectError(`${url.origin} refused the project key (HTTP ${status})`, true, status);
  if (status === 404)
    return new ConnectError(
      `${url.origin} has no runner endpoint for this project (HTTP 404): sandboxes may be off`,
      true,
      status,
    );
  return new ConnectError(`${url.origin} answered HTTP ${status}`, false, status);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
