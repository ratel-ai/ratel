import { withRequestLog } from "@/lib/platform/request-log";
import { runsApiDeps } from "@/lib/views/sandboxes/console-deps";
import { handleStartRun } from "@/lib/views/sandboxes/runs-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/projects/[projectId]/sandboxes/runs: one run by hand. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) =>
    handleStartRun(request, (await context.params).projectId, runsApiDeps),
);
