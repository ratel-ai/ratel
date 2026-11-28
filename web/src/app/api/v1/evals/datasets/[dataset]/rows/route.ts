import { BEARER_ROUTE_SCOPES } from "@/lib/platform/api-keys/routes";
import { withRequestLog } from "@/lib/platform/request-log";
import { keyRunsDeps } from "@/lib/views/evals/key-deps";
import { handleAddRowsByKey } from "@/lib/views/evals/runs-api";

export const runtime = "nodejs";

/** POST /api/v1/evals/datasets/[dataset]/rows: adds rows to a fixed dataset. */
export const POST = withRequestLog(
  async (req: Request, { params }: { params: Promise<{ dataset: string }> }) =>
    handleAddRowsByKey(
      req,
      decodeURIComponent((await params).dataset),
      keyRunsDeps(req, BEARER_ROUTE_SCOPES["POST /api/v1/evals/datasets/[dataset]/rows"]),
    ),
);
