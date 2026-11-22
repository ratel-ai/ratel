import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub signs each webhook delivery: `X-Hub-Signature-256: sha256=<hex HMAC
 * of the raw body with the webhook secret>`. Compared in constant time. Never
 * log the secret or the header.
 */

const PREFIX = "sha256=";

/** True only when `signature` is the HMAC-SHA256 of `rawBody` under `secret`. */
export function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!secret || !signature || !signature.startsWith(PREFIX)) return false;
  const given = Buffer.from(signature.slice(PREFIX.length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/** The header value GitHub would send for `rawBody`; for tests and the fake. */
export function signWebhookBody(rawBody: string | Uint8Array, secret: string): string {
  return PREFIX + createHmac("sha256", secret).update(rawBody).digest("hex");
}
