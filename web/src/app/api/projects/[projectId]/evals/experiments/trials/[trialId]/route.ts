import { withRequestLog } from "@/lib/platform/request-log";
import { consoleExperimentDeps } from "@/lib/views/evals/experiment-deps";
import { handleTrialEvidence } from "@/lib/views/evals/experiments-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: the output and the tool calls of one trial, for a member. */
export const GET = withRequestLog(
  async (
    _request: Request,
    context: { params: Promise<{ projectId: string; trialId: string }> },
  ) => {
    const { projectId, trialId } = await context.params;
    return handleTrialEvidence(projectId, trialId, consoleExperimentDeps);
  },
);
