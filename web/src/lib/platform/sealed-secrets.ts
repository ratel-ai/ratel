import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { type Config, getConfig } from "@/config";

/**
 * Secrets that a project gives to Ratel, sealed with AES-256-GCM under `SANDBOX_SECRETS_KEY`. A
 * sealed value is bound to its project, its name and its level (the project, or one sandbox of
 * the project), so a value copied onto another row, level or sandbox does not open. Never log what goes in or comes out.
 *
 * The text is `v1.<nonce>.<ciphertext and tag>`, each part in base64.
 */
export type SecretOwner = {
  projectId: string;
  name: string;
  /** The sandbox of a sandbox secret. Absent or null for a project secret. */
  sandboxName?: string | null;
};

export type SealedSecretsKey =
  | { ok: true; key: Buffer }
  | { ok: false; reason: "not_configured" | "invalid"; message: string };

const VERSION = "v1";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The sealing key. It never throws: a deployment without one starts, and the feature says so. */
export function sealedSecretsKey(
  config: Pick<Config, "sandboxes"> = getConfig(),
): SealedSecretsKey {
  const raw = config.sandboxes.secretsKey;
  if (!raw) {
    return {
      ok: false,
      reason: "not_configured",
      message: "SANDBOX_SECRETS_KEY is not configured.",
    };
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== raw) {
    return {
      ok: false,
      reason: "invalid",
      message: `SANDBOX_SECRETS_KEY must be ${KEY_BYTES} random bytes in base64 (openssl rand -base64 ${KEY_BYTES}).`,
    };
  }
  return { ok: true, key };
}

export function sealSecret(key: Buffer, owner: SecretOwner, value: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(boundTo(owner));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return [VERSION, nonce.toString("base64"), body.toString("base64")].join(".");
}

/** The clear value, or a throw when the key, the owner or a byte does not match. */
export function unsealSecret(key: Buffer, owner: SecretOwner, sealed: string): string {
  const [version, nonceText = "", bodyText = "", ...rest] = sealed.split(".");
  const nonce = Buffer.from(nonceText, "base64");
  const body = Buffer.from(bodyText, "base64");
  if (
    version !== VERSION ||
    rest.length > 0 ||
    nonce.length !== NONCE_BYTES ||
    body.length < TAG_BYTES
  ) {
    throw new Error("the text is not a sealed value");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(boundTo(owner));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("the secret does not open with this key");
  }
}

/**
 * A project secret keeps the bound data of the time before levels, so its sealed values still
 * open. A sandbox secret adds the level and the sandbox name.
 */
function boundTo({ projectId, name, sandboxName }: SecretOwner): Buffer {
  const parts = ["ratel sandbox secret", projectId, name];
  if (sandboxName != null) parts.push("sandbox", sandboxName);
  return Buffer.from(JSON.stringify(parts), "utf8");
}
