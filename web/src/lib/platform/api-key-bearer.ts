import { hashApiKey } from "@/lib/platform/api-keys";
import { type ApiKeyAuthDeps, authenticateApiKey } from "@/lib/platform/api-keys/authenticate";
import type { ApiKeyPolicy } from "@/lib/platform/api-keys/policy";
import type { ApiKeyScope } from "@/lib/platform/api-keys/scopes";
import { isDbConfigured } from "@/lib/platform/db/client";
import { findActiveApiKeyByHash, touchApiKey } from "@/lib/platform/projects/queries";

export {
  type ApiKeyAuthDeps,
  type ApiKeyAuthFailure,
  type ApiKeyAuthResult,
  type AuthenticatedApiKey,
  authenticateApiKey,
  bearerFromHeader,
} from "@/lib/platform/api-keys/authenticate";

/**
 * Bearer-key auth for every project-key surface: hash the presented key, look
 * it up among active keys, and check that it carries the scope the route needs
 * (RC-585). Every bearer route goes through `authenticateApiKey`, either
 * directly (handlers with their own injected lookups and error shapes) or via
 * `resolveProjectFromBearer`. The scope is a required argument, so a route
 * cannot authenticate without naming one, and `lib/api-keys/routes.test.ts`
 * checks that each route names the one declared for it in `BEARER_ROUTE_SCOPES`.
 *
 * A key without the scope answers 403 with a plain reason, never 401: the key
 * is valid, it just may not do this, and a client must not "fix" that by
 * re-authenticating.
 */

export type ResolvedApiKeyProject =
  | {
      ok: true;
      projectId: string;
      apiKeyId: string;
      /** What the key may do beyond this route (limits, append-only ingest). */
      policy: ApiKeyPolicy;
      rateLimitPerMinute: number | null;
    }
  | { ok: false; response: Response };

export interface ResolveProjectDeps extends ApiKeyAuthDeps {
  touchApiKey: (id: string) => Promise<void>;
}

const defaultResolveDeps: ResolveProjectDeps = {
  isDbConfigured,
  hashApiKey,
  findActiveApiKeyByHash: (hash) => findActiveApiKeyByHash(hash),
  touchApiKey,
};

/**
 * As {@link resolveProjectFromBearer}, without the last-used stamp: the queue's consumer stamps the
 * key after it stored the request (ADR-0009).
 */
export function resolveProjectFromBearerUnstamped(
  req: Request,
  scope: ApiKeyScope,
): Promise<ResolvedApiKeyProject> {
  return resolveProjectFromBearer(req, scope, {
    ...defaultResolveDeps,
    touchApiKey: async () => undefined,
  });
}

/**
 * Resolve the project a bearer key belongs to, if the key carries `scope`, so an
 * `@ratel-ai/cloud` host can act on ITS OWN project with no dashboard session.
 */
export async function resolveProjectFromBearer(
  req: Request,
  scope: ApiKeyScope,
  deps: ResolveProjectDeps = defaultResolveDeps,
): Promise<ResolvedApiKeyProject> {
  const auth = await authenticateApiKey(req.headers.get("authorization"), scope, deps);
  if (!auth.ok) {
    return {
      ok: false,
      response: Response.json(
        auth.reason === "forbidden"
          ? { error: "forbidden", reason: "missing_scope", scope, message: auth.message }
          : { error: auth.message },
        { status: auth.status },
      ),
    };
  }
  await deps.touchApiKey(auth.apiKey.id);
  return {
    ok: true,
    projectId: auth.apiKey.projectId,
    apiKeyId: auth.apiKey.id,
    policy: auth.policy,
    rateLimitPerMinute: auth.apiKey.rateLimitPerMinute,
  };
}
