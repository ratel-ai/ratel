import { createHash } from "node:crypto";
import { isLocalEnvironment } from "@/lib/platform/environment";

/**
 * Salted hashes for the two identifying values the turn ledger groups on: a search's
 * query and the end user a session served. The ledger never stores either in the clear;
 * equal inputs under the same salt hash equal, which is all the readings need ("the same
 * ask resolves to five tools").
 *
 * Queries are normalized with {@link queryKey} (case-folded, whitespace-collapsed) before
 * hashing, so a query the match-quality answer key treats as one request is one hash
 * here too. Each value is hashed under its own domain label so a query and a user id
 * that happen to be equal never collide.
 *
 * The salt comes from `TRACE_SIGNALS_HASH_SALT`. Only a local environment (APP_ENV
 * development, local or test) falls back to the committed development value. A deployed
 * environment with the secret unset (or still holding a `REPLACE_ME` placeholder) gets
 * null, and the build job refuses to hash rather than hashing under a public salt, which
 * would let a guessable query be confirmed by hashing it. Rotating the salt splits every
 * hash-keyed group from that point on.
 *
 * Owned (ADR-0030): `queryKey` is inlined from upstream's match-quality labels, which
 * are L4 and may not be imported from here.
 */

export const DEV_TRACE_SIGNALS_HASH_SALT = "ratel-trace-signals-dev-salt";

/** The literal a provisioning tool seeds a human-supplied secret with until an operator sets it. */
const SECRET_PLACEHOLDER = "REPLACE_ME";

/** Hex characters kept per hash (128 bits). */
const HASH_HEX_LENGTH = 32;

/** The hash salt, or null in a deployed environment that has none configured. */
export function traceSignalsHashSalt(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured = env.TRACE_SIGNALS_HASH_SALT?.trim();
  if (configured && configured !== SECRET_PLACEHOLDER) return configured;
  return isLocalEnvironment(env) ? DEV_TRACE_SIGNALS_HASH_SALT : null;
}

/**
 * The key a query is grouped under: trimmed, case-folded, whitespace-collapsed. Null for
 * a request whose text was never captured, so nothing is ever keyed on an empty ask.
 */
export function queryKey(query: string | null | undefined): string | null {
  if (typeof query !== "string") return null;
  const key = query.trim().toLowerCase().replace(/\s+/g, " ");
  return key.length === 0 ? null : key;
}

/** The salted hash of a normalized query, or null when no text was captured. */
export function hashQuery(query: string | null | undefined, salt: string): string | null {
  const key = queryKey(query);
  return key === null ? null : digest(salt, "query", key);
}

/** The salted hash of an end-user id, or null when none was sent. */
export function hashEndUser(endUserId: string | null | undefined, salt: string): string | null {
  if (typeof endUserId !== "string" || endUserId.length === 0) return null;
  return digest(salt, "end_user", endUserId);
}

function digest(salt: string, domain: string, value: string): string {
  return createHash("sha256")
    .update(`${salt}\u0000${domain}\u0000${value}`)
    .digest("hex")
    .slice(0, HASH_HEX_LENGTH);
}
