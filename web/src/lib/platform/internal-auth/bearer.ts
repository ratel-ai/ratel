import { createHash, timingSafeEqual } from "node:crypto";
import { type Config, getConfig } from "@/config";
import { bearerFromHeader } from "@/lib/platform/api-keys/authenticate";

/**
 * Service-to-service auth for the internal routes (docs/internal-api.md): one
 * shared value, `internal.secret` (`RATEL_INTERNAL_SECRET`), sent as
 * `Authorization: Bearer <value>`.
 *
 * Unset or short means "off": nothing is ever accepted, and the internal routes
 * answer 404.
 */

export type InternalConfig = Pick<Config, "internal">;

export const MIN_INTERNAL_SECRET_LENGTH = 32;

/** The configured value, or null when internal auth is off. */
export function internalSecret(config: InternalConfig = getConfig()): string | null {
  const value = config.internal.secret;
  return value && value.length >= MIN_INTERNAL_SECRET_LENGTH ? value : null;
}

/** Whether an Authorization header carries the internal value. Constant time. */
export function isInternalAuthorization(
  authorization: string | null,
  config: InternalConfig = getConfig(),
): boolean {
  const expected = internalSecret(config);
  const presented = bearerFromHeader(authorization);
  if (!expected || !presented) return false;
  // Digests have one length, so the compare never depends on the input's.
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * The refusal an internal route must answer with, or null when the caller may
 * go on: 404 while internal auth is off (the route does not exist), 401 without
 * the shared value.
 */
export function refuseInternalRequest(
  request: Request,
  config: InternalConfig = getConfig(),
): Response | null {
  if (!internalSecret(config)) return Response.json({ error: "Not found." }, { status: 404 });
  if (!isInternalAuthorization(request.headers.get("authorization"), config)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  return null;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
