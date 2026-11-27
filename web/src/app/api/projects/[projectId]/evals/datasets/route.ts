import { withRequestLog } from "@/lib/platform/request-log";
import { handleCreateDatasetByMember } from "@/lib/views/evals/console-api";
import { consoleApiDeps } from "@/lib/views/evals/experiment-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/projects/[projectId]/evals/datasets: a dataset of one kind. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) =>
    handleCreateDatasetByMember(request, (await context.params).projectId, consoleApiDeps),
);
