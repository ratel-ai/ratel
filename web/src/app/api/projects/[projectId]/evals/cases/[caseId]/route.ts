import { withRequestLog } from "@/lib/platform/request-log";
import { handleEditCase } from "@/lib/views/evals/cases-api";
import { casesApiDeps } from "@/lib/views/evals/console-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PUT /api/projects/[projectId]/evals/cases/[caseId]: writes the draft, or makes a new one. */
export const PUT = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string; caseId: string }> }) => {
    const { projectId, caseId } = await context.params;
    return handleEditCase(request, projectId, caseId, casesApiDeps);
  },
);
