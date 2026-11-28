import { withRequestLog } from "@/lib/platform/request-log";
import { handleRemoveDatasetRowByMember } from "@/lib/views/evals/console-api";
import { consoleApiDeps } from "@/lib/views/evals/experiment-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ projectId: string; datasetId: string; rowId: string }> };

/** DELETE /api/projects/[projectId]/evals/datasets/[datasetId]/rows/[rowId]: a row leaves its dataset. */
export const DELETE = withRequestLog(async (_request: Request, context: Context) => {
  const { projectId, datasetId, rowId } = await context.params;
  return handleRemoveDatasetRowByMember(projectId, datasetId, rowId, consoleApiDeps);
});
