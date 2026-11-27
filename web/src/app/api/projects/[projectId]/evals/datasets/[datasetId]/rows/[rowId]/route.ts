import { withRequestLog } from "@/lib/platform/request-log";
import { datasetsApiDeps } from "@/lib/views/evals/console-deps";
import { handleRemoveDatasetRow } from "@/lib/views/evals/datasets-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/projects/[projectId]/evals/datasets/[datasetId]/rows/[rowId]: removes a row. */
export const DELETE = withRequestLog(
  async (
    _request: Request,
    context: { params: Promise<{ projectId: string; datasetId: string; rowId: string }> },
  ) => {
    const { projectId, datasetId, rowId } = await context.params;
    return handleRemoveDatasetRow(projectId, datasetId, rowId, datasetsApiDeps);
  },
);
