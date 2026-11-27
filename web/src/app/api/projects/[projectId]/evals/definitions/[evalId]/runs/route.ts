import { withRequestLog } from "@/lib/platform/request-log";
import { consoleExperimentDeps } from "@/lib/views/evals/experiment-deps";
import { handleStartEvalRunByMember } from "@/lib/views/evals/run-dialog-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/projects/[projectId]/evals/definitions/[evalId]/runs: "New run" of one eval. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string; evalId: string }> }) => {
    const { projectId, evalId } = await context.params;
    return handleStartEvalRunByMember(request, projectId, evalId, consoleExperimentDeps);
  },
);
