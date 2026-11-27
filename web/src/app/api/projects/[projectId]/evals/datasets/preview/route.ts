import { withRequestLog } from "@/lib/platform/request-log";
import { handlePreviewDatasetByMember } from "@/lib/views/evals/console-api";
import { consoleApiDeps } from "@/lib/views/evals/experiment-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/projects/[projectId]/evals/datasets/preview: what a query resolves to now. */
export const POST = withRequestLog(
  async (request: Request, context: { params: Promise<{ projectId: string }> }) =>
    handlePreviewDatasetByMember(request, (await context.params).projectId, consoleApiDeps),
);
