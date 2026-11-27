import { withRequestLog } from "@/lib/platform/request-log";
import { handleApproveCase } from "@/lib/views/evals/cases-api";
import { casesApiDeps } from "@/lib/views/evals/console-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/projects/[projectId]/evals/cases/[caseId]/approve: freezes the draft. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string; caseId: string }> }) => {
    const { projectId, caseId } = await context.params;
    return handleApproveCase(request, projectId, caseId, casesApiDeps);
  },
);
