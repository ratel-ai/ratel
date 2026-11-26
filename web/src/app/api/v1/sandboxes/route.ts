import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { handleListVersions } from "@/lib/views/sandboxes/push-api";
import { pushApiDeps } from "@/lib/views/sandboxes/push-api-deps";

export const runtime = "nodejs";

/** GET /api/v1/sandboxes: the newest versions of the project of the key. */
export const GET = withRequestLog(handle);

async function handle(req: Request) {
  const deps = pushApiDeps(req, BEARER_ROUTE_SCOPES["GET /api/v1/sandboxes"]);
  return handleListVersions(req, deps);
}
