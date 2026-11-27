import { withRequestLog } from "@/lib/platform/request-log";
import { runsApiDeps } from "@/lib/views/sandboxes/console-deps";
import { handleGetRun } from "@/lib/views/sandboxes/runs-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRequestLog(
  async (_request: Request, context: { params: Promise<{ projectId: string; runId: string }> }) => {
    const { projectId, runId } = await context.params;
    return handleGetRun(projectId, runId, runsApiDeps);
  },
);
