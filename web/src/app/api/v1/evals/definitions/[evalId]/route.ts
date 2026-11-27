import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { keyModelDeps } from "@/lib/views/evals/key-deps";
import { handleGetEvalByKey } from "@/lib/views/evals/model-api";

export const runtime = "nodejs";

/** GET /api/v1/evals/definitions/[evalId]: one eval (by id or name) with its runs and scorer series. */
export const GET = withRequestLog(
  async (req: Request, { params }: { params: Promise<{ evalId: string }> }) =>
    handleGetEvalByKey(
      (await params).evalId,
      keyModelDeps(req, BEARER_ROUTE_SCOPES["GET /api/v1/evals/definitions/[evalId]"]),
    ),
);
