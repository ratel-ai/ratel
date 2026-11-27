import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { handleCreateVersion } from "@/lib/views/sandboxes/push-api";
import { pushApiDeps } from "@/lib/views/sandboxes/push-api-deps";

export const runtime = "nodejs";

/** POST /api/v1/sandboxes/versions: step 1 of a push. */
export const POST = withRequestLog(handle);

async function handle(req: Request) {
  const deps = pushApiDeps(req, BEARER_ROUTE_SCOPES["POST /api/v1/sandboxes/versions"]);
  return handleCreateVersion(req, deps);
}
