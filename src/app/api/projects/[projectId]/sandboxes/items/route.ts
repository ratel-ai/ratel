import { withRequestLog } from "@/lib/platform/request-log";
import { handleListRecordedItems } from "@/lib/views/sandboxes/run-api";
import { sandboxRunApiDeps } from "@/lib/views/sandboxes/run-api-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A sandbox's recorded production items (`?sandboxId=`), last 30 days (RC-1103). 404 while cloud-sandboxes is off. */
export const GET = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) => {
    const { projectId } = await context.params;
    return handleListRecordedItems(request, projectId, sandboxRunApiDeps);
  },
);
