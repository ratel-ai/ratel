import { withRequestLog } from "@/lib/platform/request-log";
import { handleAddDatasetRowsByMember } from "@/lib/views/evals/console-api";
import { consoleApiDeps } from "@/lib/views/evals/experiment-deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ projectId: string; datasetId: string }> };

/** POST /api/projects/[projectId]/evals/datasets/[datasetId]/rows: rows from turns or typed values. */
export const POST = withRequestLog(async (request: Request, context: Context) => {
  const { projectId, datasetId } = await context.params;
  return handleAddDatasetRowsByMember(request, projectId, datasetId, consoleApiDeps);
});
