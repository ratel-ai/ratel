import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { getConfig } from "@/config";

/**
 * Secrets the app must read back (a webhook URL), sealed with AES-256-GCM under a key derived from
 * `secrets.key` (RATEL_SECRET_KEY). The `binding` names the row the secret belongs to, so a
 * ciphertext moved to another row does not open. There is no public default key: without the
 * setting nothing is sealed, and the caller says so. Another key cannot open what this one sealed.
 */

const CIPHER = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";

/** The secret cannot be read: no key, another key, another row, or damaged. Never holds it. */
export class SecretBoxError extends Error {
  override name = "SecretBoxError";
}

/** Whether this deployment can keep secrets. */
export function secretBoxConfigured(key: string | undefined = getConfig().secrets.key): boolean {
  return Boolean(key);
}

export function sealSecret(
  plaintext: string,
  binding: string,
  key: string | undefined = getConfig().secrets.key,
): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER, derivedKey(key), nonce);
  cipher.setAAD(Buffer.from(binding));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const sealed = Buffer.concat([nonce, cipher.getAuthTag(), body]);
  return `${VERSION}.${sealed.toString("base64url")}`;
}

export function openSecret(
  sealed: string,
  binding: string,
  key: string | undefined = getConfig().secrets.key,
): string {
  const derived = derivedKey(key);
  try {
    const [version, encoded] = sealed.split(".");
    if (version !== VERSION) throw new Error("version");
    const bytes = Buffer.from(encoded, "base64url");
    const decipher = createDecipheriv(CIPHER, derived, bytes.subarray(0, NONCE_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(binding));
    decipher.setAuthTag(bytes.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(NONCE_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SecretBoxError("The stored secret cannot be opened.");
  }
}

function derivedKey(key: string | undefined): Buffer {
  if (!key) throw new SecretBoxError("RATEL_SECRET_KEY is not set.");
  return Buffer.from(hkdfSync("sha256", key, "", "ratel secret-box v1", 32));
}
