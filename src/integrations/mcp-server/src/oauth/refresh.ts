import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { RatelOAuthStore } from "./store.js";

export interface RefreshIfNeededOptions {
  /** Refresh if `expires_at - now <= skewMs`. Default 60 000 ms. */
  skewMs?: number;
  /** Test seam: override the SDK's refreshAuthorization helper. */
  refreshFn?: typeof refreshAuthorization;
  logger?: (message: string) => void;
}

export type RefreshOutcome =
  | { kind: "fresh"; tokens: OAuthTokens }
  | { kind: "refreshed"; tokens: OAuthTokens }
  | { kind: "raced"; tokens: OAuthTokens };

export class NoRefreshTokenError extends Error {
  constructor() {
    super("no refresh token available");
    this.name = "NoRefreshTokenError";
  }
}

export class MissingDiscoveryError extends Error {
  constructor() {
    super("OAuth discovery state missing — cannot refresh without authorization-server metadata");
    this.name = "MissingDiscoveryError";
  }
}

export class RefreshFailedError extends Error {
  constructor(public readonly cause: unknown) {
    super(`token refresh failed: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "RefreshFailedError";
  }
}

const DEFAULT_SKEW_MS = 60_000;

export async function refreshIfNeeded(
  store: RatelOAuthStore,
  opts: RefreshIfNeededOptions = {},
): Promise<RefreshOutcome> {
  const skewMs = opts.skewMs ?? DEFAULT_SKEW_MS;
  const refreshFn = opts.refreshFn ?? refreshAuthorization;

  const initial = await store.load();
  if (!initial.tokens) throw new NoRefreshTokenError();
  if (!initial.tokens.refresh_token) throw new NoRefreshTokenError();

  if (isFresh(initial.expires_at, skewMs)) {
    return { kind: "fresh", tokens: initial.tokens };
  }

  return store.withLock(async () => {
    const current = await store.load();
    if (current.tokens && isFresh(current.expires_at, skewMs)) {
      return { kind: "raced", tokens: current.tokens };
    }
    if (!current.tokens?.refresh_token) throw new NoRefreshTokenError();
    if (!current.client_information) throw new MissingDiscoveryError();
    const meta = current.discovery_state?.authorizationServerMetadata;
    const serverUrl = current.discovery_state?.authorizationServerUrl;
    if (!meta || !serverUrl) throw new MissingDiscoveryError();

    let next: OAuthTokens;
    try {
      next = await refreshFn(serverUrl, {
        metadata: meta,
        clientInformation: current.client_information,
        refreshToken: current.tokens.refresh_token,
      });
    } catch (err) {
      await store.clear("tokens");
      throw new RefreshFailedError(err);
    }

    await store.save({ tokens: next });
    return { kind: "refreshed", tokens: next };
  });
}

function isFresh(expiresAt: number | undefined, skewMs: number): boolean {
  if (typeof expiresAt !== "number") return false;
  return expiresAt - Date.now() > skewMs;
}
