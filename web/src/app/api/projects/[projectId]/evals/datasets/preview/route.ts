import { withRequestLog } from "@/lib/platform/request-log";
import { datasetsApiDeps } from "@/lib/views/evals/console-deps";
import { handlePreviewDataset } from "@/lib/views/evals/datasets-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/projects/[projectId]/evals/datasets/preview: the first rows that a query resolves now. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) =>
    handlePreviewDataset(request, (await context.params).projectId, datasetsApiDeps),
);
