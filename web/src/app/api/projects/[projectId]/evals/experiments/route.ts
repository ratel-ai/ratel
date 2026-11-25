import { withRequestLog } from "@/lib/platform/request-log";
import { consoleExperimentDeps } from "@/lib/views/evals/experiment-deps";
import { handleStartByMember } from "@/lib/views/evals/experiments-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/projects/[projectId]/evals/experiments: a member starts an experiment. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) =>
    handleStartByMember(request, (await context.params).projectId, consoleExperimentDeps),
);
