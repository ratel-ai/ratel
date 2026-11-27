import { composition } from "@/lib/composition/ports";
import { resolvedKeyLimits } from "@/lib/ingest/ingest-limits";
import { isDbConfigured } from "@/lib/platform/db/client";
import { checkEventQuota, getLimits } from "@/lib/platform/entitlements";
import { handleKeyResolve } from "@/lib/platform/internal-auth/key-resolve";
import { getOrganizationByProjectId } from "@/lib/platform/organizations";
import { findActiveApiKeyByHash } from "@/lib/platform/projects/queries";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";

export const runtime = "nodejs";

/**
 * POST /api/internal/keys/resolve: an ingest gateway's key lookup (docs/internal-api.md). Not a
 * bearer route: no API key reaches it, only `RATEL_INTERNAL_SECRET`, and without that setting it
 * answers 404.
 */
export const POST = withRequestLog(handlePost);

async function handlePost(request: Request): Promise<Response> {
  return handleKeyResolve(request, {
    isDbConfigured,
    findActiveApiKeyByHash: (hash) => findActiveApiKeyByHash(hash),
    getOrganizationByProjectId,
    limitsFor: resolvedKeyLimits,
    isMetered: async (organization, projectId) =>
      (await composition.traceMetering?.isMetered({ organization, projectId })) ?? false,
    monthlyEventLimit: (organization) => getLimits(organization).monthlyEventLimit,
    checkEventQuota,
    setRequestLogContext,
  });
}
