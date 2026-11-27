import { withRequestLog } from "@/lib/platform/request-log";
import { handleRecentTurnsByMember } from "@/lib/views/evals/console-api";
import { consoleApiDeps } from "@/lib/views/evals/experiment-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/projects/[projectId]/evals/recent-turns: the newest closed turns, for the trace picker. */
export const GET = withRequestLog(
  async (_request: Request, context: { params: Promise<{ projectId: string }> }) =>
    handleRecentTurnsByMember((await context.params).projectId, consoleApiDeps),
);
