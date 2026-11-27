import { withRequestLog } from "@/lib/platform/request-log";
import { handleCompareByMember } from "@/lib/views/evals/baseline-api";
import { consoleBaselineDeps } from "@/lib/views/evals/baseline-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: an experiment against the pinned baseline, for a member. */
export const GET = withRequestLog(
  async (
    _request: Request,
    context: { params: Promise<{ projectId: string; experimentId: string }> },
  ) => {
    const { projectId, experimentId } = await context.params;
    return handleCompareByMember(projectId, experimentId, consoleBaselineDeps);
  },
);
