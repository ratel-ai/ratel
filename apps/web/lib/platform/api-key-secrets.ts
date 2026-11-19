import { composition } from "@/lib/composition/ports";
import { getLogger } from "@/lib/platform/logger";

/**
 * The core's side of the `apiKeySecrets` port (`lib/contracts/api-key-secrets.ts`). Without an
 * edition that keeps keys, a key is stored as hash and prefix only and these say so.
 */

const logger = getLogger("api-key-secrets");

/** Whether keys issued now can be revealed later; the copy that shows a new key says so. */
export function apiKeysRevealable(): boolean {
  return composition.apiKeySecrets?.revealable() ?? false;
}

/**
 * Hand a key just issued to the edition to keep. Never throws: a key the edition could not keep
 * still works and is shown once. Logs the key's id only, never the plaintext.
 */
export async function keepApiKeySecret(keyId: string, plaintext: string): Promise<boolean> {
  const port = composition.apiKeySecrets;
  if (!port) return false;
  try {
    return await port.store(keyId, plaintext);
  } catch (err) {
    logger.warn(
      { apiKeyId: keyId, ...keepFailureFields(err) },
      "api key was not kept for a later reveal",
    );
    return false;
  }
}

/**
 * What a failed keep may log: the error's name and its database code. Never its message, which
 * for a failed insert repeats the query's parameters (the sealed key and its nonce).
 */
export function keepFailureFields(err: unknown): { error: string; code?: string } {
  const name = err instanceof Error ? err.name : "unknown";
  const withCode = (value: unknown) =>
    typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
      ? value.code
      : undefined;
  const code = withCode(err) ?? (err instanceof Error ? withCode(err.cause) : undefined);
  return code ? { error: name, code } : { error: name };
}
