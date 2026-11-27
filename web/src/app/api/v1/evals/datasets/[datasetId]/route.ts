import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { keyModelDeps } from "@/lib/views/evals/key-deps";
import { handleGetDatasetByKey } from "@/lib/views/evals/model-api";

export const runtime = "nodejs";

/** GET /api/v1/evals/datasets/[datasetId]: the dataset (by id or name) and its rows, no captured text. */
export const GET = withRequestLog(
  async (req: Request, { params }: { params: Promise<{ datasetId: string }> }) =>
    handleGetDatasetByKey(
      (await params).datasetId,
      keyModelDeps(req, BEARER_ROUTE_SCOPES["GET /api/v1/evals/datasets/[datasetId]"]),
    ),
);
