import { replaceCatalogSnapshot } from "@/lib/ingest/catalogs/queries";
import { handleCatalogSnapshotRequest } from "@/lib/ingest/catalogs/snapshot-handler";
import { resolveProjectFromBearer } from "@/lib/platform/api-key-bearer";
import { getOrganizationByProjectId } from "@/lib/platform/identity/queries";
import { createTokenBucketRateLimiter } from "@/lib/platform/rate-limit";
import { setRequestLogContext, withRequestLog } from "@/lib/platform/request-log";
import { trackServerEvent } from "@/lib/platform/telemetry";

export const runtime = "nodejs";

const catalogSnapshotRateLimiter = createTokenBucketRateLimiter({
  limitPerMinute: 20,
  burst: 40,
});

/** PUT /api/v1/catalog/snapshot — source-scoped full tool catalog sync. */
export const PUT = withRequestLog(handlePut);

async function handlePut(request: Request): Promise<Response> {
  return handleCatalogSnapshotRequest(request, {
    resolveProjectFromBearer,
    getOrganizationByProjectId,
    replaceCatalogSnapshot,
    rateLimiter: catalogSnapshotRateLimiter,
    setRequestLogContext,
    trackServerEvent,
  });
}
