import { withRequestLog } from "@/lib/platform/request-log";
import { evalsApiDeps } from "@/lib/views/evals/console-deps";
import { handleEditEval } from "@/lib/views/evals/evals-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/projects/[projectId]/evals/definitions/[evalId]: an edit. Other content adds a version. */
export const PUT = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string; evalId: string }> }) => {
    const { projectId, evalId } = await context.params;
    return handleEditEval(request, projectId, evalId, evalsApiDeps);
  },
);
