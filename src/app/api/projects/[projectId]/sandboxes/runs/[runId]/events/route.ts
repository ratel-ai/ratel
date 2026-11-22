import { withRequestLog } from "@/lib/platform/request-log";
import { handleRunEvents } from "@/lib/views/sandboxes/run-api";
import { sandboxRunApiDeps } from "@/lib/views/sandboxes/run-api-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A sandbox run's events as Server-Sent Events, resumable with Last-Event-ID (RC-1100). 404 while cloud-sandboxes is off. */
export const GET = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string; runId: string }> }) => {
    const { projectId, runId } = await context.params;
    return handleRunEvents(request, projectId, runId, sandboxRunApiDeps);
  },
);
