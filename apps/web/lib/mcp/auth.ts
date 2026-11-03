import { McpOperationError } from "@/lib/mcp/errors";
import { hashApiKey } from "@/lib/platform/api-keys";
import { isDbConfigured } from "@/lib/platform/db/client";
import { resolvePlanId } from "@/lib/platform/entitlements";
import { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import type { Organization } from "@/lib/platform/identity/schema";
import { findActiveApiKeyByHash, touchApiKey } from "@/lib/platform/projects/queries";

/**
 * Who is calling the MCP endpoint.
 *
 * Two credential kinds, one shape for everything downstream. This edition ships
 * the `api-key` arm only; the `oauth` arm is declared because the *tool
 * schemas* depend on it: an OAuth user may reach many projects, so every
 * project-scoped operation takes an explicit `projectId`. Keeping the shape
 * means an edition that adds browser sign-in changes no tool contract, which is
 * the difference between a compatible upgrade and a breaking one for every
 * agent that has already learned this surface.
 */

/**
 * The organization a credential reaches, as the tools report it: the immutable
 * id plus the two display fields, with the plan resolved through the
 * entitlements port (never a raw column).
 */
export interface McpOrganization {
  id: string;
  slug: string;
  effectivePlan: string;
}

export function toMcpOrganization(
  organization: Organization | null | undefined,
): McpOrganization | null {
  if (!organization) return null;
  return {
    id: organization.id,
    slug: organization.slug,
    effectivePlan: resolvePlanId(organization),
  };
}

export type McpAuthContext =
  | {
      kind: "api-key";
      /** The single project this key may act on. */
      projectId: string;
      apiKeyId: string;
      organization: McpOrganization | null;
    }
  | {
      kind: "oauth";
      /** The identity provider's id for the user. */
      externalUserId: string;
      /** Internal `users.id`, not the provider's id. */
      userId: string;
      memberships: ReadonlyArray<{
        organizationId: string;
        role: string;
        organization: McpOrganization;
      }>;
    };

export const API_KEY_PREFIX = "rtl_";

export type McpAuthResult =
  | { ok: true; auth: McpAuthContext }
  | { ok: false; error: McpOperationError };

export interface McpAuthDeps {
  isDbConfigured: () => boolean;
  findActiveApiKeyByHash: typeof findActiveApiKeyByHash;
  touchApiKey: typeof touchApiKey;
  getOrganizationByProjectId: typeof getOrganizationByProjectId;
  /** Injected so an edition with browser sign-in can supply its verifier. */
  verifyOAuthToken: (token: string) => Promise<McpAuthResult>;
}

export const defaultAuthDeps: McpAuthDeps = {
  isDbConfigured,
  findActiveApiKeyByHash,
  touchApiKey,
  getOrganizationByProjectId,
  verifyOAuthToken: refuseOAuthToken,
};

/**
 * There is no browser sign-in in this edition, so a bearer that is not a
 * project key is refused outright: no identity provider is asked, no network
 * call is made. The message says what to send instead.
 */
async function refuseOAuthToken(): Promise<McpAuthResult> {
  return {
    ok: false,
    error: new McpOperationError(
      "unauthorized",
      "Only project API keys are accepted here. Send `Authorization: Bearer rtl_...` with a key from the project's settings.",
    ),
  };
}

/** Pull the bearer token out of an Authorization header, if well-formed. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * Resolve the caller from the Authorization header.
 *
 * Two credential kinds share one entry point. An `rtl_` key follows the exact
 * `resolveProjectFromBearer` flow (`lib/platform/api-key-bearer.ts`): hash the
 * presented key, look it up among active keys, stamp last-used. It then loads
 * the organization once so `whoami` and the scoped operations reuse it rather
 * than each re-querying. Anything else is handed to the OAuth verifier.
 */
export async function authenticateMcpRequest(
  req: Request,
  deps: McpAuthDeps = defaultAuthDeps,
): Promise<McpAuthResult> {
  const token = bearerToken(req);
  if (!token) {
    return {
      ok: false,
      error: new McpOperationError(
        "unauthorized",
        "Missing or malformed Authorization header. Send `Authorization: Bearer <token>`.",
      ),
    };
  }
  if (!deps.isDbConfigured()) {
    return {
      ok: false,
      error: new McpOperationError("unavailable", "Not available. Database not configured."),
    };
  }

  // Anything that is not one of our keys is treated as an OAuth token, so a
  // client that authenticated through a browser lands here.
  if (!token.startsWith(API_KEY_PREFIX)) {
    return deps.verifyOAuthToken(token);
  }

  const apiKey = await deps.findActiveApiKeyByHash(hashApiKey(token));
  if (!apiKey) {
    return {
      ok: false,
      error: new McpOperationError("unauthorized", "Invalid, expired, or revoked API key."),
    };
  }
  await deps.touchApiKey(apiKey.id);

  const organization = await deps.getOrganizationByProjectId(apiKey.projectId);
  return {
    ok: true,
    auth: {
      kind: "api-key",
      projectId: apiKey.projectId,
      apiKeyId: apiKey.id,
      organization: toMcpOrganization(organization),
    },
  };
}

/** Stable analytics identity for the caller. */
export function authDistinctId(auth: McpAuthContext): string {
  return auth.kind === "api-key" ? `project:${auth.projectId}` : auth.externalUserId;
}

/** The organization id used for org-scoped operations. */
export function authOrganizationId(auth: McpAuthContext): string | null {
  return auth.kind === "api-key" ? (auth.organization?.id ?? null) : null;
}

/** Whether an OAuth caller belongs to the organization owning a resource. */
export function membershipFor(
  auth: McpAuthContext,
  organizationId: string,
): { organizationId: string; role: string; organization: McpOrganization } | null {
  if (auth.kind !== "oauth") return null;
  return auth.memberships.find((m) => m.organizationId === organizationId) ?? null;
}
