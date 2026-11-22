import { withRequestLog } from "@/lib/platform/request-log";
import { handleConfirmTool } from "@/lib/views/sandboxes/run-api";
import { sandboxRunApiDeps } from "@/lib/views/sandboxes/run-api-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The reviewer's decision on a confirm tool call of the caller's own live run (RC-1108). 404 while cloud-sandboxes is off. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string; runId: string }> }) => {
    const { projectId, runId } = await context.params;
    return handleConfirmTool(request, projectId, runId, sandboxRunApiDeps);
  },
);
