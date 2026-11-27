import type { EventQuotaResult } from "@/lib/contracts/entitlements";
import type { Organization } from "@/lib/contracts/session";
import { type ApiKeyPolicy, apiKeyPolicy } from "@/lib/platform/api-keys/policy";
import { type ApiKeyAccess, type ApiKeyScope, INGEST_SCOPES } from "@/lib/platform/api-keys/scopes";
import { getLogger } from "@/lib/platform/logger";
import type { ApiKey } from "@/lib/platform/projects/schema";
import type { setRequestLogContext } from "@/lib/platform/request-log";
import { type InternalConfig, refuseInternalRequest } from "./bearer";

/**
 * POST /api/internal/keys/resolve: who a key belongs to and what its limits are,
 * for an ingest gateway in front of this deployment. The answer is documented in
 * docs/internal-api.md and shared with other implementations: a change here is a
 * change there.
 *
 * An unknown, revoked or expired key is `200 {"found": false}`, so the gateway
 * can tell it from a 404 (this route is off) or a 503 (ask again).
 */
export interface LimitBucket {
  perMinute: number;
  burst: number;
}

export interface ResolvedKeyLimits {
  /** Shared (ingest-only) keys: all three signals together. Null for a secret key. */
  shared: {
    requests: { perKey: LimitBucket; perSource: LimitBucket };
    items: { perKey: LimitBucket; perSource: LimitBucket };
  } | null;
  /** Secret keys, events only. Null for a shared key. */
  events: LimitBucket | null;
}

export interface ResolvedKeyAnswer {
  found: true;
  keyId: string;
  projectId: string;
  organizationId: string;
  /** The stored scopes; `*` is every scope. */
  scopes: string[];
  /** The ingest scopes the key may use, so the gateway never reads `scopes`. */
  ingest: ApiKeyScope[];
  expiresAt: string | null;
  keyPolicy: {
    access: ApiKeyAccess;
    publishable: boolean;
    sharedKeyLimits: boolean;
    appendOnlyIngest: boolean;
  };
  limits: ResolvedKeyLimits;
  /** The monthly trace quota. `limit` null: none. `used` null: not counted or not reported. */
  quota: { limit: number | null; used: number | null; exceeded: boolean };
}

export interface KeyResolveDeps {
  config?: InternalConfig;
  isDbConfigured: () => boolean;
  findActiveApiKeyByHash: (hash: string) => Promise<ApiKey | null>;
  getOrganizationByProjectId: (projectId: string) => Promise<Organization | null>;
  /** `lib/ingest` owns the limits, so the route hands them in. */
  limitsFor: (key: ApiKey, policy: ApiKeyPolicy) => ResolvedKeyLimits;
  isMetered: (organization: Organization, projectId: string) => Promise<boolean>;
  monthlyEventLimit: (organization: Organization) => number;
  checkEventQuota: (organization: Organization) => Promise<EventQuotaResult>;
  setRequestLogContext?: typeof setRequestLogContext;
}

const KEY_HASH = /^[0-9a-f]{64}$/;
const logger = getLogger("platform/internal-auth");

export async function handleKeyResolve(request: Request, deps: KeyResolveDeps): Promise<Response> {
  const refusal = refuseInternalRequest(request, deps.config);
  if (refusal) return refusal;
  const keyHash = await readKeyHash(request);
  if (!keyHash) {
    return Response.json({ error: 'Send {"keyHash": "<sha-256 hex>"}.' }, { status: 400 });
  }
  if (!deps.isDbConfigured()) return unavailable();

  try {
    const key = await deps.findActiveApiKeyByHash(keyHash);
    if (!key) return Response.json({ found: false });
    const organization = await deps.getOrganizationByProjectId(key.projectId);
    if (!organization) {
      logger.warn({ project_id: key.projectId }, "resolved key has no organization");
      return Response.json({ found: false });
    }
    deps.setRequestLogContext?.(request, {
      project_id: key.projectId,
      org_id: organization.id,
    });
    return Response.json(await resolvedKeyAnswer(key, organization, deps));
  } catch (err) {
    logger.error({ err }, "key lookup failed");
    return unavailable();
  }
}

async function resolvedKeyAnswer(
  key: ApiKey,
  organization: Organization,
  deps: KeyResolveDeps,
): Promise<ResolvedKeyAnswer> {
  const policy = apiKeyPolicy(key.scopes);
  return {
    found: true,
    keyId: key.id,
    projectId: key.projectId,
    organizationId: organization.id,
    scopes: [...policy.scopes],
    ingest: INGEST_SCOPES.filter((scope) => policy.allows(scope)),
    expiresAt: key.expiresAt?.toISOString() ?? null,
    keyPolicy: {
      access: policy.access,
      publishable: policy.publishable,
      sharedKeyLimits: policy.sharedKeyLimits,
      appendOnlyIngest: policy.appendOnlyIngest,
    },
    limits: deps.limitsFor(key, policy),
    quota: await quotaFor(key, organization, deps),
  };
}

/** As trace ingest decides it: a metered organization has no monthly cap. */
async function quotaFor(
  key: ApiKey,
  organization: Organization,
  deps: KeyResolveDeps,
): Promise<ResolvedKeyAnswer["quota"]> {
  if (await deps.isMetered(organization, key.projectId)) {
    return { limit: null, used: null, exceeded: false };
  }
  const quota = await deps.checkEventQuota(organization);
  if (!quota.ok) return { limit: quota.limit, used: quota.used, exceeded: true };
  const limit = deps.monthlyEventLimit(organization);
  return { limit: Number.isFinite(limit) ? limit : null, used: null, exceeded: false };
}

async function readKeyHash(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { keyHash?: unknown } | null;
    const value = body?.keyHash;
    return typeof value === "string" && KEY_HASH.test(value) ? value : null;
  } catch {
    // Not JSON: the 400 says what to send.
    return null;
  }
}

function unavailable(): Response {
  return Response.json(
    { error: "Not available. Try again." },
    { status: 503, headers: { "Retry-After": "5" } },
  );
}
