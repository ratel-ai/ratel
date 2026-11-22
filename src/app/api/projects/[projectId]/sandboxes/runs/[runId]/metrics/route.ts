import { withRequestLog } from "@/lib/platform/request-log";
import { handleRunMetrics } from "@/lib/views/sandboxes/run-api";
import { sandboxRunApiDeps } from "@/lib/views/sandboxes/run-api-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The caller's run's tokens, cost and latency from its trace (RC-1103). 404 while cloud-sandboxes is off. */
export const GET = withRequestLog(
  async (_request: Request, context: { params: Promise<{ projectId: string; runId: string }> }) => {
    const { projectId, runId } = await context.params;
    return handleRunMetrics(projectId, runId, sandboxRunApiDeps);
  },
);
