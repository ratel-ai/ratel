import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { handleUploadBundle } from "@/lib/views/sandboxes/push-api";
import { pushApiDeps } from "@/lib/views/sandboxes/push-api-deps";

export const runtime = "nodejs";

/** PUT /api/v1/sandboxes/versions/[versionId]/bundle: step 2 of a push, when the bundle store takes no direct upload. */
export const PUT = withRequestLog(handle);

async function handle(req: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const deps = pushApiDeps(
    req,
    BEARER_ROUTE_SCOPES["PUT /api/v1/sandboxes/versions/[versionId]/bundle"],
  );
  return handleUploadBundle(req, (await params).versionId, deps);
}
