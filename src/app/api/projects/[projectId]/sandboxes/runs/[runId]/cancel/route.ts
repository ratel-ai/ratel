import { withRequestLog } from "@/lib/platform/request-log";
import { handleCancelRun } from "@/lib/views/sandboxes/run-api";
import { sandboxRunApiDeps } from "@/lib/views/sandboxes/run-api-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cancel the caller's own live sandbox run (RC-1100). 404 while cloud-sandboxes is off. */
export const POST = withRequestLog(
  async (_request: Request, context: { params: Promise<{ projectId: string; runId: string }> }) => {
    const { projectId, runId } = await context.params;
    return handleCancelRun(projectId, runId, sandboxRunApiDeps);
  },
);
