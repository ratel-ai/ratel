import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, short-lived values that carry the GitHub App install flow across
 * GitHub's redirect (RC-914). Two kinds:
 *
 * - `state`: made when a person clicks Install on a project's Repository tab.
 *   It names the project and the person. It rides in `state` through GitHub and in an
 *   httpOnly cookie; the two must match. A missing, mismatched, forged or
 *   expired one writes nothing.
 * - `grant`: made by the setup route once the state checked out and GitHub
 *   listed the person's own installations. It holds only those installation
 *   ids, so the repo picker and the link action trust nothing else.
 *
 * Signed with HMAC-SHA256 under a key derived from the webhook secret (one
 * secret fewer to run); each kind is its own key, so one never passes as the other.
 */

export interface SetupState {
  projectId: string;
  externalId: string;
}

export interface InstallGrant extends SetupState {
  /** Installations the person can reach on GitHub, from their own `GET /user/installations`. */
  installationIds: number[];
}

type Kind = "state" | "grant";

/** How long a person has between Install and GitHub's redirect back. */
export const SETUP_STATE_TTL_MS = 15 * 60_000;
/** How long the repo picker works after the setup redirect. */
export const INSTALL_GRANT_TTL_MS = 60 * 60_000;

export function signSetupState(state: SetupState, secret: string, nowMs: number): string {
  return sign(
    "state",
    { p: state.projectId, u: state.externalId, e: nowMs + SETUP_STATE_TTL_MS },
    secret,
  );
}

/** The state's project and person, or null when it is missing, forged, malformed or expired. */
export function verifySetupState(
  token: string | null | undefined,
  secret: string,
  nowMs: number,
): SetupState | null {
  const payload = verify("state", token, secret, nowMs);
  if (!payload || typeof payload.p !== "string" || typeof payload.u !== "string") return null;
  return { projectId: payload.p, externalId: payload.u };
}

export function signInstallGrant(grant: InstallGrant, secret: string, nowMs: number): string {
  return sign(
    "grant",
    {
      p: grant.projectId,
      u: grant.externalId,
      i: grant.installationIds,
      e: nowMs + INSTALL_GRANT_TTL_MS,
    },
    secret,
  );
}

export function verifyInstallGrant(
  token: string | null | undefined,
  secret: string,
  nowMs: number,
): InstallGrant | null {
  const payload = verify("grant", token, secret, nowMs);
  if (!payload || typeof payload.p !== "string" || typeof payload.u !== "string") return null;
  const ids = payload.i;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    !ids.every((id) => Number.isSafeInteger(id) && id > 0)
  )
    return null;
  return { projectId: payload.p, externalId: payload.u, installationIds: ids as number[] };
}

interface Payload {
  p?: unknown;
  u?: unknown;
  i?: unknown;
  e: number;
}

function sign(kind: Kind, payload: Payload, secret: string): string {
  if (!secret) throw new Error("setup state needs a secret");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(kind, body, secret).toString("base64url")}`;
}

function verify(
  kind: Kind,
  token: string | null | undefined,
  secret: string,
  nowMs: number,
): Payload | null {
  if (!token || !secret) return null;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const given = Buffer.from(signature, "base64url");
  const expected = mac(kind, body, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
  } catch {
    return null;
  }
  if (typeof payload?.e !== "number" || payload.e <= nowMs) return null;
  return payload;
}

function mac(kind: Kind, body: string, secret: string): Buffer {
  const key = createHmac("sha256", secret).update(`ratel-github-setup:${kind}:v1`).digest();
  return createHmac("sha256", key).update(body).digest();
}
