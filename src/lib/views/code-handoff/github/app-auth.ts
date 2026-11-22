import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

/**
 * GitHub App authentication. The App signs a short JWT (RS256, its private
 * key from `GITHUB_APP_PRIVATE_KEY`) and trades it for an installation token
 * per installation. Tokens live one hour; each is cached and reused until
 * `REFRESH_MARGIN_MS` before it expires. Never log the key, the JWT or a token.
 */

export interface AppCredentials {
  appId: string;
  /** The PEM. Escaped newlines (`\n`, as an env value often has them) are accepted. */
  privateKey: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

export interface InstallationTokenDeps {
  fetch: typeof fetch;
  now: () => number;
  apiBase?: string;
}

export interface InstallationTokens {
  get(installationId: number): Promise<string>;
  /** Drop a cached token (after GitHub answered 401 with it). */
  forget(installationId: number): void;
}

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
/** A token is renewed this long before it expires. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** GitHub caps the JWT at 10 minutes; `iat` is back-dated against clock drift. */
const JWT_TTL_S = 9 * 60;
const JWT_BACKDATE_S = 60;

/**
 * Installation tokens for one App, cached until near expiry. Two callers that
 * ask at once for the same installation share one request.
 */
export function createInstallationTokens(
  credentials: AppCredentials,
  deps: InstallationTokenDeps,
): InstallationTokens {
  const key = parsePrivateKey(credentials.privateKey);
  const cache = new Map<number, InstallationToken>();
  const pending = new Map<number, Promise<InstallationToken>>();
  const apiBase = deps.apiBase ?? GITHUB_API_BASE;

  async function request(installationId: number): Promise<InstallationToken> {
    const jwt = signAppJwt(credentials.appId, key, deps.now());
    const response = await deps.fetch(
      `${apiBase}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: githubHeaders(jwt),
      },
    );
    if (response.status !== 201) {
      throw new Error(`github installation token request failed with status ${response.status}`);
    }
    const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
      throw new Error("github installation token response has no token or expiry");
    }
    return { token: body.token, expiresAt: new Date(body.expires_at) };
  }

  return {
    async get(installationId) {
      const cached = cache.get(installationId);
      if (cached && cached.expiresAt.getTime() - REFRESH_MARGIN_MS > deps.now())
        return cached.token;
      let inflight = pending.get(installationId);
      if (!inflight) {
        inflight = request(installationId).finally(() => pending.delete(installationId));
        pending.set(installationId, inflight);
      }
      const fresh = await inflight;
      cache.set(installationId, fresh);
      return fresh.token;
    },
    forget(installationId) {
      cache.delete(installationId);
    },
  };
}

/** The App's JWT at `nowMs`: `iss` the App id, valid for 9 minutes from a minute back. */
export function signAppJwt(appId: string, privateKey: KeyObject | string, nowMs: number): string {
  const key = typeof privateKey === "string" ? parsePrivateKey(privateKey) : privateKey;
  const nowS = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: nowS - JWT_BACKDATE_S, exp: nowS + JWT_TTL_S, iss: appId }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(key);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** The headers of every GitHub REST call with this bearer (an App JWT or an installation token). */
export function githubHeaders(bearer: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${bearer}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "ratel-cloud",
  };
}

function parsePrivateKey(pem: string): KeyObject {
  return createPrivateKey(pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem);
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}
