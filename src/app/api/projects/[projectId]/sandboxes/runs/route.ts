import { withRequestLog } from "@/lib/platform/request-log";
import { handleListRuns, handleStartRun } from "@/lib/views/sandboxes/run-api";
import { sandboxRunApiDeps } from "@/lib/views/sandboxes/run-api-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start a sandbox run on the caller's own runner (RC-1100). 404 while cloud-sandboxes is off. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) => {
    const { projectId } = await context.params;
    return handleStartRun(request, projectId, sandboxRunApiDeps);
  },
);

/** The caller's own runs of one sandbox (`?sandboxId=`), newest first (RC-1102). 404 while cloud-sandboxes is off. */
export const GET = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) => {
    const { projectId } = await context.params;
    return handleListRuns(request, projectId, sandboxRunApiDeps);
  },
);
