import { withRequestLog } from "@/lib/platform/request-log";
import { datasetsApiDeps } from "@/lib/views/evals/console-deps";
import { handleCreateDataset } from "@/lib/views/evals/datasets-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/projects/[projectId]/evals/datasets: creates a dataset of one kind. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) =>
    handleCreateDataset(request, (await context.params).projectId, datasetsApiDeps),
);
