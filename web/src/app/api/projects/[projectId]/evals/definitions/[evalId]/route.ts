import { withRequestLog } from "@/lib/platform/request-log";
import { handleEditEvalByMember } from "@/lib/views/evals/console-api";
import { consoleApiDeps } from "@/lib/views/evals/experiment-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/projects/[projectId]/evals/definitions/[evalId]: an edit. Other content adds a version. */
export const PUT = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string; evalId: string }> }) => {
    const { projectId, evalId } = await context.params;
    return handleEditEvalByMember(request, projectId, evalId, consoleApiDeps);
  },
);
