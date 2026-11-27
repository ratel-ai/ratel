import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { keyModelDeps } from "@/lib/views/evals/key-deps";
import { handleAddRowsByKey } from "@/lib/views/evals/model-api";

export const runtime = "nodejs";

/** POST /api/v1/evals/datasets/[datasetId]/rows: adds trace turns or typed values to a fixed dataset. */
export const POST = withRequestLog(
  async (req: Request, { params }: { params: Promise<{ datasetId: string }> }) =>
    handleAddRowsByKey(
      req,
      (await params).datasetId,
      keyModelDeps(req, BEARER_ROUTE_SCOPES["POST /api/v1/evals/datasets/[datasetId]/rows"]),
    ),
);
