import { withRequestLog } from "@/lib/platform/request-log";
import { handleCompareItems } from "@/lib/views/sandboxes/run-api";
import { sandboxRunApiDeps } from "@/lib/views/sandboxes/run-api-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Check a compare selection (at most 50 recorded items) and resolve its items (RC-1103). 404 while cloud-sandboxes is off. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) => {
    const { projectId } = await context.params;
    return handleCompareItems(request, projectId, sandboxRunApiDeps);
  },
);
