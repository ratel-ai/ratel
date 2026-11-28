import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { handleStartSandboxRun } from "@/lib/views/sandboxes/sandbox-runs-api";
import { sandboxRunsApiDeps } from "@/lib/views/sandboxes/sandbox-runs-api-deps";

export const runtime = "nodejs";

/** POST /api/v1/sandbox-runs: runs the newest ready version of a sandbox name, or a version. */
export const POST = withRequestLog(async (req: Request) =>
  handleStartSandboxRun(
    req,
    sandboxRunsApiDeps(req, BEARER_ROUTE_SCOPES["POST /api/v1/sandbox-runs"]),
  ),
);
