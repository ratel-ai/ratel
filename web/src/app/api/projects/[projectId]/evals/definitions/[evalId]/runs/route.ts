import { withRequestLog } from "@/lib/platform/request-log";
import { handleStartRunByMember } from "@/lib/views/evals/console-api";
import { consoleApiDeps } from "@/lib/views/evals/experiment-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/projects/[projectId]/evals/definitions/[evalId]/runs: a run with changes for itself only. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string; evalId: string }> }) => {
    const { projectId, evalId } = await context.params;
    return handleStartRunByMember(request, projectId, evalId, consoleApiDeps);
  },
);
