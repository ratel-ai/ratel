import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The runner socket token. `POST /api/v1/runner/connect` trades a project key
 * for it, so the long-lived key never travels on the websocket URL. The gateway
 * verifies it on upgrade with the same code and the same secret
 * (`SANDBOX_GATEWAY_TOKEN_SECRET`).
 *
 * Format: `<base64url(claims JSON)>.<base64url(HMAC-SHA256 of the first part)>`.
 * Pure computation, no I/O: the caller passes the secret and the clock.
 */

export interface SandboxTokenClaims {
  v: 1;
  /** Project the runner serves. */
  projectId: string;
  organizationId: string;
  /** Clerk id of the runner owner: the creator of the project key. */
  ownerUserId: string;
  apiKeyId: string;
  /** Issued at and expiry, seconds since the epoch. */
  iat: number;
  exp: number;
}

export type SandboxTokenFailure = "malformed" | "bad_signature" | "expired";

export const SANDBOX_TOKEN_TTL_SECONDS = 15 * 60;
/** A secret shorter than this is refused: HMAC-SHA256 wants 32 bytes of key. */
export const MIN_TOKEN_SECRET_LENGTH = 32;

/** Signs a token for these claims, valid for 15 minutes from `now`. */
export function signSandboxToken(
  claims: Omit<SandboxTokenClaims, "v" | "iat" | "exp">,
  secret: string,
  now: Date,
): { token: string; expiresAt: Date } {
  assertSecret(secret);
  const iat = Math.floor(now.getTime() / 1000);
  const full: SandboxTokenClaims = { v: 1, ...claims, iat, exp: iat + SANDBOX_TOKEN_TTL_SECONDS };
  const body = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
  return { token: `${body}.${signature(body, secret)}`, expiresAt: new Date(full.exp * 1000) };
}

/** The claims of a valid, unexpired token, or why it is refused. */
export function verifySandboxToken(
  token: string,
  secret: string,
  now: Date,
): { ok: true; claims: SandboxTokenClaims } | { ok: false; reason: SandboxTokenFailure } {
  assertSecret(secret);
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(signature(body, secret), "utf8");
  const given = Buffer.from(sig, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return { ok: false, reason: "bad_signature" };
  const claims = parseClaims(body);
  if (!claims) return { ok: false, reason: "malformed" };
  if (claims.exp <= Math.floor(now.getTime() / 1000)) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

function signature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function parseClaims(body: string): SandboxTokenClaims | null {
  try {
    const value = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Partial<SandboxTokenClaims>;
    const strings = [value.projectId, value.organizationId, value.ownerUserId, value.apiKeyId];
    if (value.v !== 1 || strings.some((s) => typeof s !== "string" || s.length === 0)) return null;
    if (!Number.isInteger(value.iat) || !Number.isInteger(value.exp)) return null;
    return value as SandboxTokenClaims;
  } catch {
    return null;
  }
}

function assertSecret(secret: string): void {
  if (secret.length < MIN_TOKEN_SECRET_LENGTH) throw new Error("sandbox token secret is too short");
}
