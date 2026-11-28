import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { handleGetVersion } from "@/lib/views/sandboxes/push-api";
import { pushApiDeps } from "@/lib/views/sandboxes/push-api-deps";

export const runtime = "nodejs";

/** GET /api/v1/sandboxes/versions/[versionId]: one version, its preparation state and its smoke check. */
export const GET = withRequestLog(handle);

async function handle(req: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const deps = pushApiDeps(req, BEARER_ROUTE_SCOPES["GET /api/v1/sandboxes/versions/[versionId]"]);
  return handleGetVersion(req, (await params).versionId, deps);
}
