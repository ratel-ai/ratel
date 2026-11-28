import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { handleGetSandboxRun } from "@/lib/views/sandboxes/sandbox-runs-api";
import { sandboxRunsApiDeps } from "@/lib/views/sandboxes/sandbox-runs-api-deps";

export const runtime = "nodejs";

/** GET /api/v1/sandbox-runs/[id]: one run, with its output, tool calls, usage, error and logs. */
export const GET = withRequestLog(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) =>
    handleGetSandboxRun(
      req,
      (await params).id,
      sandboxRunsApiDeps(req, BEARER_ROUTE_SCOPES["GET /api/v1/sandbox-runs/[id]"]),
    ),
);
