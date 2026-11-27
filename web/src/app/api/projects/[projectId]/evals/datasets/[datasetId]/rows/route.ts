import { withRequestLog } from "@/lib/platform/request-log";
import { datasetsApiDeps } from "@/lib/views/evals/console-deps";
import { handleAddDatasetRows } from "@/lib/views/evals/datasets-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/projects/[projectId]/evals/datasets/[datasetId]/rows: adds rows to a fixed dataset. */
export const POST = withRequestLog(
  async (
    request: Request,
    context: { params: Promise<{ projectId: string; datasetId: string }> },
  ) => {
    const { projectId, datasetId } = await context.params;
    return handleAddDatasetRows(request, projectId, datasetId, datasetsApiDeps);
  },
);
