import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { handleFinalizeVersion } from "@/lib/views/sandboxes/push-api";
import { pushApiDeps } from "@/lib/views/sandboxes/push-api-deps";

export const runtime = "nodejs";

/** POST /api/v1/sandboxes/versions/[versionId]/finalize: step 3 of a push: checks the bundle. */
export const POST = withRequestLog(handle);

async function handle(req: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const deps = pushApiDeps(
    req,
    BEARER_ROUTE_SCOPES["POST /api/v1/sandboxes/versions/[versionId]/finalize"],
  );
  return handleFinalizeVersion((await params).versionId, deps);
}
