import { createHash, randomBytes } from "node:crypto";

/**
 * Ingest API keys. The plaintext key is shown to the owner exactly once, at
 * creation; we persist only its SHA-256 hash plus a recognizable prefix. The SDK
 * sends the plaintext as `Authorization: Bearer <key>`; the ingest endpoint
 * (Phase 6) hashes the incoming key and looks it up by `key_hash`.
 *
 * A project may hold several live keys at once — one per environment or
 * integration — each with an optional name and an optional expiry. Expiry is
 * opt-in: a key with no `expiresAt` never expires, which is what every key
 * issued before the column existed keeps.
 */

const KEY_PREFIX = "rtl_";

/** Names are display-only labels ("Staging", "CI"), so a short cap is plenty. */
export const API_KEY_NAME_MAX_LEN = 64;

/**
 * The lifetimes a key can be issued for. Fixed presets rather than a free date
 * picker: the choice is always relative to "now", the server owns the clock
 * (nothing to fake from the client), and there is no timezone or past-date case
 * to validate. `null` months = never expires.
 */
type ExpirySpec = { label: string; days?: number; months?: number };

const EXPIRY_PRESETS = {
  "1w": { label: "1 week", days: 7 },
  "1mo": { label: "1 month", months: 1 },
  "3mo": { label: "3 months", months: 3 },
  "6mo": { label: "6 months", months: 6 },
  "12mo": { label: "12 months", months: 12 },
  "2y": { label: "2 years", months: 24 },
  never: { label: "Never" },
} as const satisfies Record<string, ExpirySpec>;

export type ApiKeyExpiryPreset = keyof typeof EXPIRY_PRESETS;

/** What a key gets when the caller doesn't choose — unchanged from before presets. */
export const DEFAULT_API_KEY_EXPIRY: ApiKeyExpiryPreset = "never";

/** Dropdown options, shortest-lived first with "Never" last. */
export const API_KEY_EXPIRY_CHOICES: ReadonlyArray<{
  value: ApiKeyExpiryPreset;
  label: string;
}> = (Object.keys(EXPIRY_PRESETS) as ApiKeyExpiryPreset[]).map((value) => ({
  value,
  label: EXPIRY_PRESETS[value].label,
}));

export type GeneratedApiKey = {
  /** Full secret — returned to the owner once, never stored. */
  plaintext: string;
  /** Short, non-secret prefix stored for display (e.g. "rtl_a1b2c3d4"). */
  prefix: string;
  /** SHA-256 hex of the plaintext — what we store and look up by. */
  hash: string;
};

/** The two timestamps that decide whether a stored key still authenticates. */
export type ApiKeyLifecycle = {
  revokedAt: Date | null;
  expiresAt: Date | null;
};

export type ApiKeyStatus = "active" | "expired" | "revoked";

export function generateApiKey(): GeneratedApiKey {
  const plaintext = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, KEY_PREFIX.length + 8),
    hash: hashApiKey(plaintext),
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Whether a key's expiry has passed. Expiry is exclusive: a key stops working
 * at its expiry instant, not one tick after. Keep this in step with the SQL
 * predicate in `findActiveApiKeyByHash` — they answer the same question, one in
 * Postgres for the auth path and one in TypeScript for the dashboard.
 */
export function isApiKeyExpired(
  key: Pick<ApiKeyLifecycle, "expiresAt">,
  now: Date = new Date(),
): boolean {
  return key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime();
}

/**
 * The status shown in the key list. Revocation is deliberate and permanent, so
 * it outranks expiry — a key revoked before its expiry date reads as "revoked".
 */
export function apiKeyStatus(key: ApiKeyLifecycle, now: Date = new Date()): ApiKeyStatus {
  if (key.revokedAt !== null) return "revoked";
  return isApiKeyExpired(key, now) ? "expired" : "active";
}

export type NormalizedApiKeyName = { ok: true; name: string | null } | { ok: false; error: string };

/** Trim a user-supplied label; blank means "no name", not an empty string. */
export function normalizeApiKeyName(raw: string | null | undefined): NormalizedApiKeyName {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: true, name: null };
  if (trimmed.length > API_KEY_NAME_MAX_LEN) {
    return {
      ok: false,
      error: `Key name must be ${API_KEY_NAME_MAX_LEN} characters or fewer.`,
    };
  }
  return { ok: true, name: trimmed };
}

export type ResolvedApiKeyExpiry =
  | { ok: true; expiresAt: Date | null }
  | { ok: false; error: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Turn the chosen preset into the instant the key stops working. Unrecognized
 * input is rejected rather than quietly falling back to "never" — a mangled
 * request should not silently issue a permanent credential.
 */
export function resolveApiKeyExpiry(
  preset: ApiKeyExpiryPreset | null | undefined,
  now: Date = new Date(),
): ResolvedApiKeyExpiry {
  const chosen = preset ?? DEFAULT_API_KEY_EXPIRY;
  if (!Object.hasOwn(EXPIRY_PRESETS, chosen)) {
    return { ok: false, error: "Choose one of the offered expiration options." };
  }

  const spec: ExpirySpec = EXPIRY_PRESETS[chosen];
  if (spec.days !== undefined) {
    return { ok: true, expiresAt: new Date(now.getTime() + spec.days * DAY_MS) };
  }
  if (spec.months !== undefined) {
    return { ok: true, expiresAt: addMonths(now, spec.months) };
  }
  return { ok: true, expiresAt: null };
}

/**
 * Add whole months in UTC, clamping to the end of the target month. Without the
 * clamp, a key created on the 31st would roll into the following month (Aug 31
 * + 6 months landing in March rather than February).
 */
function addMonths(from: Date, months: number): Date {
  const result = new Date(from);
  const day = result.getUTCDate();
  // Park on the 1st so the month shift can't overflow before we clamp.
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDayOfMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDayOfMonth));
  return result;
}
