import { withRequestLog } from "@/lib/platform/request-log";
import { handleCompareByMember } from "@/lib/views/evals/baseline-api";
import { consoleBaselineDeps } from "@/lib/views/evals/baseline-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: an experiment against the one in `?baseline=`, else the pinned baseline, for a member. */
export const GET = withRequestLog(
  async (
    request: Request,
    context: { params: Promise<{ projectId: string; experimentId: string }> },
  ) => {
    const { projectId, experimentId } = await context.params;
    const baselineId = new URL(request.url).searchParams.get("baseline");
    return handleCompareByMember(projectId, experimentId, consoleBaselineDeps, baselineId);
  },
);
