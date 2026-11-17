import { type ApiKeyPolicy, apiKeyPolicy } from "@/lib/platform/api-keys/policy";
import { type ApiKeyScope, missingScopeMessage } from "@/lib/platform/api-keys/scopes";
import { getLogger } from "@/lib/platform/logger";

/**
 * The one decision every bearer route shares (RC-585): is this a live key, and
 * does it carry the scope the route needs? Free of database imports so the
 * request handlers that inject their own lookups can use it as is;
 * `lib/api-keys/bearer.ts` wires the real lookup for everyone else.
 */

const logger = getLogger("api-keys/authenticate");

/** The stored key columns auth reads. A full `ApiKey` row satisfies it. */
export type AuthenticatedApiKey = {
  id: string;
  projectId: string;
  keyPrefix: string;
  scopes: string[];
  rateLimitPerMinute: number | null;
};

export interface ApiKeyAuthDeps<Key extends AuthenticatedApiKey = AuthenticatedApiKey> {
  isDbConfigured: () => boolean;
  hashApiKey: (plaintext: string) => string;
  findActiveApiKeyByHash: (hash: string) => Promise<Key | null>;
}

export type ApiKeyAuthFailure = {
  ok: false;
  reason: "missing" | "unavailable" | "invalid" | "forbidden";
  status: 401 | 403 | 503;
  message: string;
};

export type ApiKeyAuthResult<Key extends AuthenticatedApiKey = AuthenticatedApiKey> =
  | { ok: true; apiKey: Key; policy: ApiKeyPolicy }
  | ApiKeyAuthFailure;

const FAILURES = {
  missing: { status: 401, message: "Missing or malformed Authorization: Bearer <key>." },
  unavailable: { status: 503, message: "Not available. Database not configured." },
  invalid: { status: 401, message: "Invalid or revoked API key." },
} as const;

function failure(reason: keyof typeof FAILURES): ApiKeyAuthFailure {
  return { ok: false, reason, ...FAILURES[reason] };
}

/** The presented key from an Authorization header value, if well-formed. */
export function bearerFromHeader(authorization: string | null): string | null {
  const match = (authorization ?? "").match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * The one decision every bearer route shares. Does not stamp last-used: each
 * caller does that when it is ready (some only after the request succeeds).
 */
export async function authenticateApiKey<Key extends AuthenticatedApiKey>(
  authorization: string | null,
  /** The scope the route needs, or several of which any one will do (MCP). */
  scope: ApiKeyScope | readonly [ApiKeyScope, ...ApiKeyScope[]],
  deps: ApiKeyAuthDeps<Key>,
): Promise<ApiKeyAuthResult<Key>> {
  const token = bearerFromHeader(authorization);
  if (!token) return failure("missing");
  if (!deps.isDbConfigured()) return failure("unavailable");
  const apiKey = await deps.findActiveApiKeyByHash(deps.hashApiKey(token));
  if (!apiKey) return failure("invalid");
  // The policy decides (`policy.ts`); a row without scopes grants nothing.
  const policy = apiKeyPolicy(apiKey.scopes);
  const anyOf: readonly ApiKeyScope[] = typeof scope === "string" ? [scope] : scope;
  if (!policy.allowsAny(anyOf)) {
    reportScopeDenied(apiKey, anyOf[0]);
    return { ok: false, reason: "forbidden", status: 403, message: missingScopeMessage(anyOf[0]) };
  }
  return { ok: true, apiKey, policy };
}

/**
 * A misconfigured client retries, so one key can be refused many times a
 * second. Log each (key, scope) at most once per window.
 */
const DENIAL_LOG_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED_DENIALS = 1_000;
const lastDenialLoggedAt = new Map<string, number>();

function reportScopeDenied(apiKey: AuthenticatedApiKey, scope: ApiKeyScope): void {
  const key = `${apiKey.id}:${scope}`;
  const now = Date.now();
  const previous = lastDenialLoggedAt.get(key);
  if (previous !== undefined && now - previous < DENIAL_LOG_WINDOW_MS) return;
  if (lastDenialLoggedAt.size >= MAX_TRACKED_DENIALS) lastDenialLoggedAt.clear();
  lastDenialLoggedAt.set(key, now);
  logger.warn(
    { apiKeyId: apiKey.id, projectId: apiKey.projectId, keyPrefix: apiKey.keyPrefix, scope },
    "refused api key without scope",
  );
}
